// `kanban run` subcommand — wires the runner loop (§4.2 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`) to a Commander subcommand so
// users can drive the loop from the shell.
//
// Flag surface:
//
//   --config FILE       override the discovery walk-up and read FILE
//                       directly; bypasses the .kanban-runner.yaml lookup.
//   --board ID          mode-1 (board-bound): the board to watch. Pairs
//                       with --status.
//   --status S          mode-1 column status (todo|in_progress|review|done).
//   --mine              mode-2 (identity-bound): pick from any task the
//                       CLI profile owns; requires the profile to be logged
//                       in.
//   --once              process a single task and exit (handy for cron /
//                       smoke tests). The loop still installs the SIGINT /
//                       SIGTERM handlers so a Ctrl-C during the spawn is a
//                       clean drain.
//
// Argument validation runs before the loop starts: the mutex between
// mode-1 and mode-2 plus the requirement that mode-1 pairs board + status
// is checked up front so the CLI fails fast with exit code 1 instead of
// half-starting a loop and then erroring out.
//
// We deliberately keep this module thin: it parses flags, loads +
// validates the runner config, constructs the loop's collaborators, and
// drives it. The state machine itself lives in `runner/loop.ts`.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { HttpClient } from "../http/client.js";
import type { OAuthClient } from "../auth/client.js";
import type {
  RunnerConfig,
  RunnerStatus,
} from "../runner/types.js";
import {
  RunnerConfigError,
  loadConfig,
  parseConfig,
  validate,
} from "../runner/config.js";
import { RunClaimClient } from "../runner/claim.js";
import { HeartbeatScheduler } from "../runner/heartbeat.js";
import { RunLoop, type RunLoopSummary } from "../runner/loop.js";
import { ChildProcessSpawner } from "../runner/spawn.js";
import {
  watchBoardNotifications,
  type RunWatchHandle,
} from "../runner/watcher.js";
import type {
  BoardContext,
  ColumnContext,
  CommentContext,
  SubtaskContext,
  TaskHydrator,
} from "../runner/prompt.js";
import type { TaskRecord } from "./tasks.js";

export class InvalidUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageError";
  }
}

const ALLOWED_STATUSES: readonly RunnerStatus[] = ["todo", "in_progress", "review", "done"];

export interface RunCommandOptions {
  /** Path to a runner config file (overrides discovery). */
  configPath?: string;
  /** mode-1: board id to watch. */
  boardId?: string;
  /** mode-1: column status to watch. */
  status?: string;
  /** mode-2: pick tasks the CLI profile owns. */
  mine?: boolean;
  /** Process one task and exit (no idle polling). */
  once?: boolean;
  /**
   * Enable verbose trace logging (`--debug`). When true the runner
   * loop emits additional `[kanban-runner] debug: …` lines to stderr
   * so operators can correlate in-flight tasks with claim /
   * heartbeat / spawn events.
   */
  debug?: boolean;
  /** API URL passed through to the HttpClient. */
  apiUrl: string;
  /** Credential profile passed through to the HttpClient + OAuth. */
  profile?: string;
  /** Test seam: cancel the loop via this AbortController. */
  abortController?: AbortController;
  /** Test seam: replace the loop body so unit tests can assert without spawning. */
  buildLoop?: BuildLoopFn;
  /** Working directory used for config discovery. */
  cwd?: string;
  /** Streams for the logger; tests pass capture streams. */
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
}

export type BuildLoopFn = (deps: {
  config: RunnerConfig;
  runnerId: string;
  agentType: string;
  http: HttpClient;
  signal?: AbortSignal;
  abortController?: AbortController;
  debug?: boolean;
}) => RunLoop | Promise<RunLoop>;

export interface RunCommandResult {
  config: RunnerConfig;
  runnerId: string;
  summary: RunLoopSummary;
}

export interface ParsedRunFlags {
  configPath?: string;
  boardId?: string;
  status?: RunnerStatus;
  mine: boolean;
  once: boolean;
  debug: boolean;
}

/**
 * Parse and validate the `--board` / `--status` / `--mine` flag triple.
 * Mutually exclusive logic:
 *
 *   * `--mine` is incompatible with `--board` / `--status`.
 *   * When neither is supplied, the validator reads the on-disk config
 *     for the actual mode.
 *   * When mode-1 is selected, both `--board` and `--status` are required.
 *
 * Returned object exposes the resolved mode so the caller can layer it
 * on top of any config-file defaults.
 */
export function parseRunFlags(flags: {
  config?: string;
  board?: string;
  status?: string;
  mine?: boolean;
  once?: boolean;
  debug?: boolean;
}): ParsedRunFlags {
  const configPath = flags.config?.trim() ? flags.config.trim() : undefined;
  const boardId = flags.board?.trim() ? flags.board.trim() : undefined;
  const statusRaw = flags.status?.trim() ? flags.status.trim() : undefined;
  const mine = flags.mine === true;
  const once = flags.once === true;
  const debug = flags.debug === true;
  const status: RunnerStatus | undefined = statusRaw
    ? assertStatus(statusRaw)
    : undefined;
  if (mine && (boardId || status)) {
    throw new InvalidUsageError(
      "--mine is mutually exclusive with --board / --status"
    );
  }
  if (!mine && (boardId === undefined) !== (status === undefined)) {
    throw new InvalidUsageError(
      "--board and --status must be supplied together (mode-1) or both omitted (mode-2)"
    );
  }
  return { configPath, boardId, status, mine, once, debug };
}

function assertStatus(value: string): RunnerStatus {
  if (!(ALLOWED_STATUSES as readonly string[]).includes(value)) {
    throw new InvalidUsageError(
      `invalid --status '${value}'; allowed: ${ALLOWED_STATUSES.join(", ")}`
    );
  }
  return value as RunnerStatus;
}

/**
 * Resolve the runner config for a given working directory. CLI flag
 * overrides (`--board` / `--status` / `--mine`) win over file values
 * because that's the documented "command-line beats config file" rule.
 */
export function resolveRunnerConfig(
  cwd: string,
  parsed: ParsedRunFlags
): RunnerConfig {
  const base = parsed.configPath
    ? loadFromPath(parsed.configPath)
    : loadConfig(cwd);
  if (parsed.mine) {
    base.mode = "mine";
    delete base.boardId;
    delete base.status;
  } else if (parsed.boardId || parsed.status) {
    base.mode = undefined;
    if (parsed.boardId) base.boardId = parsed.boardId;
    if (parsed.status) base.status = parsed.status;
  }
  return base;
}

function loadFromPath(path: string): RunnerConfig {
  if (!existsSync(path)) {
    throw new RunnerConfigError(
      `runner config not found at ${path}`,
      "<path>"
    );
  }
  const text = readFileSync(path, "utf8");
  const isJson = path.endsWith(".json");
  let raw: unknown;
  try {
    raw = isJson ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new RunnerConfigError(
      `failed to parse runner config ${path}: ${(err as Error).message}`,
      "<root>"
    );
  }
  return parseConfig(path, raw);
}

/**
 * Build a `TaskHydrator` backed by the supplied `HttpClient`. Each
 * accessor is best-effort: a failure returns an empty array / a
 * placeholder object so the prompt renderer can still produce a usable
 * payload (per §4.4 of the plan).
 */
export function buildHttpHydrator(
  http: HttpClient,
  opts: { boardId?: string } = {}
): TaskHydrator {
  return {
    async fetchComments(taskId: string): Promise<CommentContext[]> {
      try {
        const res = await http.apiGet<{ comments?: CommentContext[] }>(
          `/api/v1/comments?taskId=${encodeURIComponent(taskId)}`
        );
        return Array.isArray(res.comments) ? res.comments : [];
      } catch {
        return [];
      }
    },
    async fetchSubtasks(taskId: string): Promise<SubtaskContext[]> {
      try {
        const res = await http.apiGet<{ subtasks?: SubtaskContext[] }>(
          `/api/v1/subtasks?taskId=${encodeURIComponent(taskId)}`
        );
        return Array.isArray(res.subtasks) ? res.subtasks : [];
      } catch {
        return [];
      }
    },
    async fetchTask(taskId: string): Promise<TaskRecord> {
      try {
        return await http.apiGet<TaskRecord>(
          `/api/v1/tasks/${encodeURIComponent(taskId)}`
        );
      } catch {
        return { id: taskId };
      }
    },
    async fetchBoard(boardId: string): Promise<BoardContext> {
      const id = boardId || opts.boardId || "";
      if (!id) return { id: "", name: "(unknown board)" };
      try {
        const res = await http.apiGet<{
          id?: string;
          name?: string;
          description?: string;
        }>(`/api/v1/boards/${encodeURIComponent(id)}`);
        return {
          id: res.id ?? id,
          name: res.name ?? id,
          description: res.description ?? null,
        };
      } catch {
        return { id, name: id, description: null };
      }
    },
    async fetchColumn(columnId: string): Promise<ColumnContext> {
      const id = columnId || "";
      if (!id) return { id: "", name: "(unknown column)" };
      try {
        const res = await http.apiGet<{
          id?: string;
          name?: string;
          status?: string;
          description?: string;
        }>(`/api/v1/columns/${encodeURIComponent(id)}`);
        return {
          id: res.id ?? id,
          name: res.name ?? id,
          status: res.status ?? null,
          description: res.description ?? null,
        };
      } catch {
        return { id, name: id, status: null, description: null };
      }
    },
  };
}

/**
 * Build a `FailureCommentPoster` that POSTs to `/api/v1/comments`. Used
 * by the loop when an agent crashes or exits non-zero.
 */
export function buildCommentPoster(
  http: HttpClient
): import("../runner/loop.js").FailureCommentPoster {
  return {
    async postComment(taskId: string, body: string): Promise<void> {
      await http.apiPost("/api/v1/comments", { taskId, body });
    },
  };
}

/**
 * Default loop factory: wires `RunClaimClient` + `HeartbeatScheduler`
 * + `ChildProcessSpawner` + the `TaskHydrator` against the supplied
 * `HttpClient`. Tests can pass a `buildLoop` override to inject a stub.
 *
 * The loop's logger defaults to a no-op so unit tests stay terse; the
 * CLI passes a stderr-backed logger so operators can correlate log
 * lines with the in-flight task on the server (the loop logs the
 * runnerId at start, every claim, and every finish — see
 * `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §5).
 *
 * As of s-1130 the loop also subscribes to the server's WebSocket
 * broadcast stream so a freshly-created task reaches the runner
 * without waiting for the next `pollIntervalMs` tick. The underlying
 * polling is preserved as a fallback so a WS disconnect can't strand
 * the runner. mode=mine (no boardId) skips the subscription because
 * the server doesn't broadcast "your task" events on the global
 * stream — the poll path is the only mechanism there.
 */
export function defaultBuildLoop(deps: Parameters<BuildLoopFn>[0]): RunLoop {
  const { config, runnerId, agentType, http, signal, abortController, debug } = deps;
  const claimClient = RunClaimClient.fromHttpClient(http);
  const heartbeat = new HeartbeatScheduler(claimClient, runnerId, {
    intervalMs: config.runner.heartbeatIntervalMs ?? 30_000,
  });
  const hydrator = buildHttpHydrator(http, {
    boardId: config.boardId,
  });
  const commentPoster = buildCommentPoster(http);
  const loop = new RunLoop({
    config,
    runnerId,
    agentType,
    claimClient,
    heartbeat,
    hydrator,
    commentPoster,
    spawner: new ChildProcessSpawner({
      timeoutMs: config.agent.timeoutMs ?? 1_800_000,
    }),
    signal,
    abortController,
    logger: stderrLoopLogger({ debug: debug === true }),
  });
  startBoardWatcherIfPossible({ loop, config, http, signal, debug });
  return loop;
}

interface BoardWatcherDeps {
  loop: RunLoop;
  config: RunnerConfig;
  http: HttpClient;
  signal?: AbortSignal;
  debug?: boolean;
}

/**
 * Subscribe to the server's task_notification stream when the
 * runner is bound to a specific board (mode-1). mode=mine has no
 * boardId to filter on so we skip — the underlying poll loop is
 * the only wake-up mechanism in that case.
 *
 * Token resolution: prefer the HttpClient's bearer token (it
 * already manages OAuth refresh); fall back to an empty string so
 * the upgrade is rejected cleanly and the WS reconnects once the
 * real token lands on the next poll.
 *
 * The watcher closes itself when the abort signal fires, so we
 * don't leak the WS goroutine past graceful shutdown.
 */
function startBoardWatcherIfPossible(deps: BoardWatcherDeps): void {
  const { loop, config, http, signal, debug } = deps;
  const boardId = config.boardId;
  if (!boardId) {
    // mode=mine: no boardId to filter on; skip.
    return;
  }
  const log = stderrLoopLogger({ debug: debug === true });
  log.debug(`board watcher: subscribing to notifications for board=${boardId}`);
  let handle: RunWatchHandle | null = null;
  let cancelled = false;
  void (async () => {
    let token = "";
    try {
      token = (await http.bearerToken()) ?? "";
    } catch {
      token = "";
    }
    if (cancelled || !token) {
      log.debug("board watcher: cancelled before WS upgrade");
      return;
    }
    handle = watchBoardNotifications({
      apiUrl: http.apiUrl,
      boardId,
      token,
      onNotification: () => {
        // We only care about create / attach — the runner
        // already knows about update_status from the
        // heartbeat / claim cycle, so anything else would
        // just thrash the wake-up path.
        log.debug("board watcher: notification received; waking loop");
        loop.wake();
      },
      onDisconnect: () => {
        // The underlying poll loop covers disconnects; the
        // watcher just shaves latency off the happy path.
        log.debug("board watcher: disconnected; poll loop will resume");
      },
      signal,
    });
    log.debug(`board watcher: connected (board=${boardId})`);
  })();
  if (signal) {
    const close = (): void => {
      cancelled = true;
      log.debug("board watcher: abort signal received; closing");
      handle?.close();
    };
    if (signal.aborted) {
      close();
    } else {
      signal.addEventListener("abort", close, { once: true });
    }
  }
}

/**
 * Stderr-backed logger for the runner loop. The CLI is a long-lived
 * process that operators tail, so routing log lines to stderr (and
 * not stdout, which is reserved for command output / piped JSON)
 * matches the convention of every other kanban subcommand. Lines are
 * prefixed with `[kanban-runner]` so the operator can grep them out
 * of a mixed log stream.
 *
 * When `debug` is true the logger also emits verbose trace lines
 * (prefixed with `debug:`) covering claim attempts, polling delays,
 * spawn details, hydration results, and result handling. The default
 * logger is silent on `debug()` so operators who don't pass `--debug`
 * see no change in log volume.
 *
 * The `stderr` stream is injectable so tests can capture output
 * without polluting the real process stderr; production callers omit
 * it and get `process.stderr`.
 */
export function stderrLoopLogger(
  opts: { debug?: boolean; stderr?: NodeJS.WritableStream } = {}
): import("../runner/loop.js").RunLoopLogger {
  const debug = opts.debug === true;
  const err = opts.stderr ?? process.stderr;
  return {
    info(msg: string): void {
      err.write(`[kanban-runner] ${msg}\n`);
    },
    warn(msg: string): void {
      err.write(`[kanban-runner] warn: ${msg}\n`);
    },
    error(msg: string): void {
      err.write(`[kanban-runner] error: ${msg}\n`);
    },
    debug(msg: string): void {
      if (!debug) return;
      err.write(`[kanban-runner] debug: ${msg}\n`);
    },
  };
}

/**
 * Pick the agent type for the run — defaults to "opencode" but honours
 * an override through `KANBAN_RUNNER_AGENT_TYPE`. The CLI's OAuth
 * `user_agent` field is the source of truth on the server; we currently
 * hard-code "opencode" because that's what the demo env uses, but the
 * override is there so other runners can be exercised without
 * recompiling.
 */
export function resolveAgentType(): string {
  return process.env.KANBAN_RUNNER_AGENT_TYPE ?? "opencode";
}

/**
 * Generate a `runnerId` when the config doesn't supply one. Format
 * mirrors the §2.2 default: `<hostname>-<pid>-<uuid>`. Each invocation
 * gets a fresh UUID so re-running the same binary doesn't reuse a stale
 * id (which would prevent the server from cleaning up the previous run).
 */
export function defaultRunnerId(): string {
  let host = "localhost";
  try {
    host = hostname();
  } catch {
    host = "localhost";
  }
  const pid = typeof process !== "undefined" && process.pid ? process.pid : 0;
  return `${host}-${pid}-${randomUUID()}`;
}

/**
 * Build an `isLoggedIn` predicate that consults the supplied OAuth
 * client. We look at the stored credentials directly so we don't need
 * to perform an active `whoami` round-trip; the server will still
 * surface a 401 on the first claim attempt if the token is stale.
 */
export function oauthLoggedInPredicate(
  oauth: OAuthClient | null | undefined
): (profile: string | undefined) => boolean {
  return (profile) => {
    void profile;
    if (!oauth) return false;
    const creds = oauth.loadCredentials();
    if (!creds) return false;
    if (creds.accessToken && creds.accessToken.length > 0) return true;
    if (creds.refreshToken && creds.refreshToken.length > 0) return true;
    return false;
  };
}

/**
 * Drive the runner end-to-end:
 *
 *   1. Parse + validate the CLI flags.
 *   2. Load the runner config (discovery or explicit --config path).
 *   3. Validate the config (mutex / agent.bin / lock-timeout ratio /
 *      mode-mine login check).
 *   4. Construct the loop with the supplied collaborators.
 *   5. Install SIGINT / SIGTERM handlers (production callers only).
 *   6. Run until shutdown or --once completion.
 *   7. Always return a `RunCommandResult` so callers can render a final
 *      report.
 */
export async function runRunCommand(
  options: RunCommandOptions,
  deps: {
    http: HttpClient;
    oauth?: OAuthClient | null;
    cwd: string;
    buildLoop?: BuildLoopFn;
    abortController?: AbortController;
  }
): Promise<RunCommandResult> {
  const parsed = parseRunFlags({
    config: options.configPath,
    board: options.boardId,
    status: options.status,
    mine: options.mine,
    once: options.once,
    debug: options.debug,
  });
  let config: RunnerConfig;
  try {
    config = resolveRunnerConfig(options.cwd ?? deps.cwd, parsed);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      throw new InvalidUsageError(err.message);
    }
    throw err;
  }
  let valid: RunnerConfig;
  try {
    valid = validate(config, {
      isLoggedIn: oauthLoggedInPredicate(deps.oauth),
    });
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      throw new InvalidUsageError(err.message);
    }
    throw err;
  }
  const runnerId =
    valid.runner.runnerId && valid.runner.runnerId.length > 0
      ? valid.runner.runnerId
      : defaultRunnerId();
  const buildLoop = options.buildLoop ?? deps.buildLoop ?? defaultBuildLoop;
  const abort =
    options.abortController ?? deps.abortController ?? new AbortController();
  const loop = await buildLoop({
    config: valid,
    runnerId,
    agentType: resolveAgentType(),
    http: deps.http,
    signal: abort.signal,
    abortController: abort,
    debug: parsed.debug,
  });
  installSignalHandlers(abort);
  const summary = await driveLoop(loop, parsed.once, abort);
  return { config: valid, runnerId, summary };
}

async function driveLoop(
  loop: RunLoop,
  once: boolean,
  abort: AbortController
): Promise<RunLoopSummary> {
  if (once) {
    const cap = 1_000;
    for (let i = 0; i < cap; i++) {
      const alive = await loop.tick();
      if (!alive) break;
      if (loop.state.processed >= 1) break;
    }
    loop.requestShutdown();
    return loop.run();
  }
  void abort;
  return loop.run();
}

function installSignalHandlers(abort: AbortController): void {
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  const onSig = (): void => abort.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
}

// Re-export for callers that want to log a structured runner id without
// reaching into the runner module's internals.
export function formatRunnerId(runnerId: string): string {
  return runnerId;
}
