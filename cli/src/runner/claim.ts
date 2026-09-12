// Runner HTTP client — wraps the four `/api/v1/runs/*` endpoints
// defined in `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml`.
//
// The loop module consumes this façade instead of `HttpClient`
// directly so:
//
//   * Status-code semantics (`204`, `409`) are flattened into typed
//     results (`ClaimOutcome.kind === "none"`, `HeartbeatOutcome.kind
//     === "lost"`), keeping the loop's branching obvious.
//   * Network errors degrade to `RunnerHttpError` with a flag the
//     loop can inspect (`retryable`) — the loop retries transient
//     failures but fails closed on 4xx.
//   * The runner never refreshes credentials during a heartbeat
//     cycle, so we expose `withClient()` so tests can inject a
//     mock fetch without going through `HttpClient`'s OAuth
//     machinery.
//
// Wire shape recap (from the OpenAPI doc):
//
//   POST /runs/claim            → 200 ClaimRunResponse | 204 No Content
//   POST /runs/:taskId/heartbeat→ 200 HeartbeatResponse | 409 Conflict
//   POST /runs/:taskId/finish   → 200 FinishRunResponse | 409 Conflict
//   POST /runs/release          → 200 ReleaseRunsResponse

import { ApiError, HttpClient, NetworkError } from "../http/client.js";
import type { TaskRecord } from "../commands/tasks.js";

export type ClaimMode = "board" | "mine";

export interface ClaimRequest {
  boardId: string;
  status: string;
  agentType: string;
  runnerId: string;
  mode?: ClaimMode;
}

/**
 * Server-side `task_runs` row payload. Mirrors the
 * `TaskRun` schema in the OpenAPI doc; we type it loosely so partial
 * responses (e.g. older server versions) still parse.
 */
export interface TaskRunRecord {
  taskId?: string;
  runnerId?: string;
  agentId?: string;
  boardId?: string;
  columnId?: string;
  status?: string;
  claimedAt?: string;
  lastHeartbeatAt?: string;
  expiresAt?: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
}

/**
 * Successful claim result. The server returns the full task JSON
 * plus the run row metadata so the CLI can render the prompt without
 * a second round-trip.
 */
export interface ClaimSuccess {
  kind: "claimed";
  task: TaskRecord;
  run: TaskRunRecord;
}

/**
 * 204 outcome — there was no eligible task at the moment.
 */
export interface ClaimNone {
  kind: "none";
}

export type ClaimOutcome = ClaimSuccess | ClaimNone;

export interface HeartbeatSuccess {
  kind: "ok";
  expiresAt: string;
}

export interface HeartbeatLost {
  kind: "lost";
}

export type HeartbeatOutcome = HeartbeatSuccess | HeartbeatLost;

export type FinishStatus = "completed" | "failed";

export interface FinishRequest {
  runnerId: string;
  status: FinishStatus;
  exitCode?: number | null;
  error?: string | null;
}

export interface FinishSuccess {
  kind: "ok";
  advanced: boolean;
}

export interface FinishConflict {
  kind: "conflict";
}

export type FinishOutcome = FinishSuccess | FinishConflict;

export interface ReleaseRequest {
  runnerId: string;
  taskIds?: string[];
}

export interface ReleaseSuccess {
  kind: "ok";
  released: number;
}

export type ReleaseOutcome = ReleaseSuccess;

/**
 * Error type raised when the runner can't reach the kanban server in a
 * way that is *not* a documented protocol-level response (network
 * outage, malformed body, etc.). The `retryable` flag hints to the
 * loop whether to back off + retry or fail-closed.
 */
export class RunnerHttpError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  readonly path: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; path?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "RunnerHttpError";
    this.retryable = opts.retryable ?? true;
    this.status = opts.status ?? 0;
    this.path = opts.path ?? "";
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/**
 * Abstract transport — the loop module calls these four methods. The
 * default implementation (`HttpClient`) wraps the real kanban server;
 * tests inject a fake to drive scripted 200 / 204 / 409 / 500
 * responses.
 */
export interface RunTransport {
  postJson<T>(path: string, body: unknown, init?: { signal?: AbortSignal }): Promise<{ status: number; body: T | null }>;
}

/**
 * Default `RunTransport` backed by the CLI's `HttpClient`. The transport
 * preserves the raw status so the typed results (`ClaimOutcome` etc.)
 * can branch on `204` / `409` without losing information.
 */
export class HttpRunTransport implements RunTransport {
  private readonly client: HttpClient;

  constructor(client: HttpClient) {
    this.client = client;
  }

  async postJson<T>(
    path: string,
    body: unknown,
    init: { signal?: AbortSignal } = {}
  ): Promise<{ status: number; body: T | null }> {
    const fullPath = path.startsWith("/api/v1") ? path : `/api/v1${path}`;
    const res = await this.rawPost(fullPath, body, init.signal);
    const text = await res.text();
    let parsed: T | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        throw new RunnerHttpError(`failed to parse JSON from ${fullPath}`, {
          retryable: false,
          status: res.status,
          path: fullPath,
        });
      }
    }
    return { status: res.status, body: parsed };
  }

  private async rawPost(
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      const url = `${this.client.apiUrl}${path}`;
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      const token = await this.client.bearerToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const init: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      };
      if (signal) init.signal = signal;
      const clientLike = this.client as unknown as { fetchImpl?: typeof fetch };
      const fetchImpl =
        clientLike.fetchImpl ??
        (globalThis as { fetch?: typeof fetch }).fetch ??
        globalThis.fetch;
      return await fetchImpl(url, init);
    } catch (err) {
      if (err instanceof RunnerHttpError) throw err;
      throw new RunnerHttpError(`network error contacting ${path}`, {
        retryable: true,
        cause: err,
        path,
      });
    }
  }
}

/**
 * Thin façade that turns the raw transport into typed outcomes. The
 * four public methods (`claim`, `heartbeat`, `finish`, `release`) are
 * the only surface the loop module imports.
 */
export class RunClaimClient {
  private readonly transport: RunTransport;

  constructor(transport: RunTransport) {
    this.transport = transport;
  }

  /** Convenience constructor that wires an `HttpRunTransport`. */
  static fromHttpClient(client: HttpClient): RunClaimClient {
    return new RunClaimClient(new HttpRunTransport(client));
  }

  /**
   * Atomically claim the next eligible task. The server returns:
   *
   *   * `200 ClaimRunResponse` — wraps `{ task, run }`. We unwrap to
   *     a `ClaimSuccess` so the loop doesn't have to inspect
   *     `body.task` etc.
   *   * `204 No Content` — surfaced as `ClaimNone`. The loop should
   *     sleep `pollIntervalMs` and try again.
   *   * `409 Conflict` — surfaced as a `RunnerHttpError` with
   *     `retryable=false`; the loop must surface this as a fatal
   *     "configuration" error (typically means the column's
   *     `agent_types` no longer contains the runner's `agentType`).
   *   * `5xx` / network errors — surfaced as a `RunnerHttpError` with
   *     `retryable=true`; the loop should back off and retry.
   */
  async claim(req: ClaimRequest): Promise<ClaimOutcome> {
    const path = "/runs/claim";
    try {
      const { status, body } = await this.transport.postJson<
        ClaimSuccessResponse | null
      >(path, {
        boardId: req.boardId,
        status: req.status,
        agentType: req.agentType,
        runnerId: req.runnerId,
        mode: req.mode,
      });
      if (status === 204) return { kind: "none" };
      if (status >= 200 && status < 300) {
        const task = body?.task ?? {};
        const run = body?.run ?? {};
        return { kind: "claimed", task, run };
      }
      throw new RunnerHttpError(`unexpected claim response status ${status}`, {
        retryable: status >= 500,
        status,
        path,
      });
    } catch (err) {
      throw normaliseError(err, path);
    }
  }

  async heartbeat(taskId: string, runnerId: string): Promise<HeartbeatOutcome> {
    const path = `/runs/${encodeURIComponent(taskId)}/heartbeat`;
    try {
      const { status, body } = await this.transport.postJson<HeartbeatSuccessResponse | null>(
        path,
        { runnerId }
      );
      if (status === 409) return { kind: "lost" };
      if (status >= 200 && status < 300) {
        const expiresAt = body?.expiresAt ?? "";
        return { kind: "ok", expiresAt };
      }
      throw new RunnerHttpError(`unexpected heartbeat response status ${status}`, {
        retryable: status >= 500,
        status,
        path,
      });
    } catch (err) {
      if (err instanceof RunnerHttpError && err.status === 409) {
        return { kind: "lost" };
      }
      throw normaliseError(err, path);
    }
  }

  async finish(taskId: string, req: FinishRequest): Promise<FinishOutcome> {
    const path = `/runs/${encodeURIComponent(taskId)}/finish`;
    try {
      const { status, body } = await this.transport.postJson<FinishSuccessResponse | null>(
        path,
        {
          runnerId: req.runnerId,
          status: req.status,
          exitCode: req.exitCode ?? null,
          error: req.error ?? null,
        }
      );
      if (status === 409) return { kind: "conflict" };
      if (status >= 200 && status < 300) {
        const advanced = body?.advanced === true;
        return { kind: "ok", advanced };
      }
      throw new RunnerHttpError(`unexpected finish response status ${status}`, {
        retryable: status >= 500,
        status,
        path,
      });
    } catch (err) {
      if (err instanceof RunnerHttpError && err.status === 409) {
        return { kind: "conflict" };
      }
      throw normaliseError(err, path);
    }
  }

  async release(req: ReleaseRequest): Promise<ReleaseOutcome> {
    const path = "/runs/release";
    try {
      const { status, body } = await this.transport.postJson<ReleaseSuccessResponse | null>(
        path,
        { runnerId: req.runnerId, taskIds: req.taskIds ?? null }
      );
      if (status >= 200 && status < 300) {
        const released = typeof body?.released === "number" ? body.released : 0;
        return { kind: "ok", released };
      }
      throw new RunnerHttpError(`unexpected release response status ${status}`, {
        retryable: status >= 500,
        status,
        path,
      });
    } catch (err) {
      throw normaliseError(err, path);
    }
  }
}

interface ClaimSuccessResponse {
  task?: TaskRecord;
  run?: TaskRunRecord;
}

interface HeartbeatSuccessResponse {
  expiresAt?: string;
}

interface FinishSuccessResponse {
  success?: boolean;
  advanced?: boolean;
}

interface ReleaseSuccessResponse {
  released?: number;
}

/**
 * Map a transport-level error to a `RunnerHttpError`. We deliberately
 * re-throw `RunnerHttpError` unchanged so the caller's branching on
 * `err.status === 409` keeps working.
 */
function normaliseError(err: unknown, path: string): RunnerHttpError {
  if (err instanceof RunnerHttpError) return err;
  if (err instanceof NetworkError) {
    return new RunnerHttpError(err.message, {
      retryable: true,
      status: 0,
      path,
      cause: err,
    });
  }
  if (err instanceof ApiError) {
    const retryable = err.kind === "network" || err.kind === "server";
    return new RunnerHttpError(err.message, {
      retryable,
      status: err.status,
      path,
      cause: err,
    });
  }
  return new RunnerHttpError(
    `unexpected error contacting ${path}: ${(err as Error).message ?? String(err)}`,
    { retryable: true, cause: err, path }
  );
}
