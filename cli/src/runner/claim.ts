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
  /**
   * Captured stderr (≤ 64 KiB). Reserved for true failure
   * context — non-zero exit, signal, spawn error. Since s-1185
   * the runner keeps the agent's stdout in a separate
   * `output` field so a successful run is no longer
   * mis-labelled as "Error" on the task detail page just
   * because the agent wrote a banner to stderr.
   */
  error?: string | null;
  /**
   * Captured stdout (≤ 64 KiB). Populated for both completed
   * and failed runs so the comment stream, task detail page,
   * and run history can all surface the agent's actual reply.
   */
  output?: string | null;
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
 * Callback that attempts to refresh the OAuth access token. Returns
 * `true` when a fresh token is now available on the credential store,
 * `false` when no refresh token exists or the refresh failed (network
 * down, refresh token revoked, etc.). The runner calls this whenever
 * a `/api/v1/runs/*` request returns 401 so a stale-but-logged-in
 * session doesn't have to drop out and re-authenticate.
 */
export type RefreshAuthFn = () => Promise<boolean>;

export interface RunClaimClientOptions {
  /**
   * Refresh hook invoked on a 401 response. The default is a no-op so
   * the existing test suite (which uses fake transports) keeps passing;
   * production callers wire this to `oauth.refreshTokens()` via
   * `defaultBuildLoop` so the runner mirrors the regular HttpClient's
   * retry-on-401 semantics.
   */
  refreshAuth?: RefreshAuthFn;
}

/**
 * Thin façade that turns the raw transport into typed outcomes. The
 * four public methods (`claim`, `heartbeat`, `finish`, `release`) are
 * the only surface the loop module imports.
 */
export class RunClaimClient {
  private readonly transport: RunTransport;
  private refreshAuth: RefreshAuthFn;

  constructor(transport: RunTransport, opts: RunClaimClientOptions = {}) {
    this.transport = transport;
    this.refreshAuth = opts.refreshAuth ?? noopRefresh;
  }

  /** Convenience constructor that wires an `HttpRunTransport`. */
  static fromHttpClient(client: HttpClient): RunClaimClient {
    return new RunClaimClient(new HttpRunTransport(client));
  }

  /**
   * Replace the refresh hook. Used by `defaultBuildLoop` after the
   * OAuthClient is wired up, so the loop factory can construct the
   * RunClaimClient first and inject auth dependencies lazily.
   */
  setRefreshAuth(refreshAuth: RefreshAuthFn): void {
    this.refreshAuth = refreshAuth;
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
    const body = {
      boardId: req.boardId,
      status: req.status,
      agentType: req.agentType,
      runnerId: req.runnerId,
      mode: req.mode,
    };
    return this.executeWithAuthRetry<ClaimSuccessResponse, ClaimOutcome>(
      path,
      body,
      (status, body) => {
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
      }
    );
  }

  async heartbeat(taskId: string, runnerId: string): Promise<HeartbeatOutcome> {
    const path = `/runs/${encodeURIComponent(taskId)}/heartbeat`;
    return this.executeWithAuthRetry<HeartbeatSuccessResponse, HeartbeatOutcome>(
      path,
      { runnerId },
      (status, body) => {
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
      }
    );
  }

  async finish(taskId: string, req: FinishRequest): Promise<FinishOutcome> {
    const path = `/runs/${encodeURIComponent(taskId)}/finish`;
    return this.executeWithAuthRetry<FinishSuccessResponse, FinishOutcome>(
      path,
      {
        runnerId: req.runnerId,
        status: req.status,
        exitCode: req.exitCode ?? null,
        error: req.error ?? null,
        output: req.output ?? null,
      },
      (status, body) => {
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
      }
    );
  }

  async release(req: ReleaseRequest): Promise<ReleaseOutcome> {
    const path = "/runs/release";
    return this.executeWithAuthRetry<ReleaseSuccessResponse, ReleaseOutcome>(
      path,
      { runnerId: req.runnerId, taskIds: req.taskIds ?? null },
      (status, body) => {
        if (status >= 200 && status < 300) {
          const released = typeof body?.released === "number" ? body.released : 0;
          return { kind: "ok", released };
        }
        throw new RunnerHttpError(`unexpected release response status ${status}`, {
          retryable: status >= 500,
          status,
          path,
        });
      }
    );
  }

  /**
   * Shared request helper used by claim / heartbeat / finish / release.
   *
   * When the server returns 401 we attempt one token refresh and retry
   * exactly once. This mirrors the regular HttpClient's retry-on-401
   * behaviour so the runner doesn't shut down with an opaque "API
   * error 401" the moment the access token ages out — the OAuthClient
   * still holds a valid refresh token in most cases, so a single
   * round-trip to the token endpoint resolves the staleness.
   *
   * Failure modes:
   *
   *   * refresh hook returns false (no refresh token / refresh call
   *     failed)  → surface `RunnerHttpError` with `retryable: false`
   *     and a "session expired" message so the loop can call
   *     `requestShutdown()` and the operator sees a clear "Run
   *     `kanban auth login` again" hint rather than an opaque 401.
   *   * refresh succeeded but the retried request still 401s
   *     → same outcome (the refresh token itself is invalid; the
   *     operator must re-authenticate from scratch).
   */
  private async executeWithAuthRetry<B, T>(
    path: string,
    body: unknown,
    parse: (status: number, body: B | null) => T
  ): Promise<T> {
    let attempt = 0;
    let res: { status: number; body: B | null };
    try {
      res = await this.transport.postJson<B>(path, body);
    } catch (err) {
      throw normaliseError(err, path);
    }
    if (res.status === 401 && attempt === 0) {
      attempt += 1;
      const refreshed = await this.safeRefresh();
      if (!refreshed) {
        throw new RunnerHttpError(
          `authentication required: session expired (refresh failed); run \`kanban auth login\` to re-authenticate`,
          { retryable: false, status: 401, path }
        );
      }
      try {
        res = await this.transport.postJson<B>(path, body);
      } catch (err) {
        throw normaliseError(err, path);
      }
      if (res.status === 401) {
        throw new RunnerHttpError(
          `authentication required: session expired even after refresh; run \`kanban auth login\` to re-authenticate`,
          { retryable: false, status: 401, path }
        );
      }
    }
    return parse(res.status, res.body);
  }

  private async safeRefresh(): Promise<boolean> {
    try {
      return await this.refreshAuth();
    } catch {
      return false;
    }
  }
}

async function noopRefresh(): Promise<boolean> {
  return false;
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
