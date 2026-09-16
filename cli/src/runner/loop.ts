// Run loop — implements the state machine described in §4.2 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// The loop owns a single `inFlight` slot (one task at a time, per
// F6). Each tick it either:
//
//   * watches an in-flight agent (heartbeat deadline check, exit
//     handling), or
//   * asks the server for the next claimable task.
//
// The module is deliberately **stateless across ticks**: every input
// it needs (cfg, claim client, spawner, heartbeat scheduler, comment
// poster) is injected via the constructor. This keeps the test
// surface small — we can drive the loop with a scripted claim client
// and a fake `ProcessSpawner`, then assert the sequence of calls and
// final state with no real I/O.
//
// Signal handling is **NOT** installed by this module. The caller is
// expected to install SIGTERM / SIGINT handlers that call
// `loop.requestShutdown()`. This makes the loop embeddable in tests
// (we just resolve the shutdown promise) and in other contexts
// (program.ts wires the real OS signals).

import type { TaskRecord } from "../commands/tasks.js";
import type { ArgVariableValues, RunnerConfig } from "./types.js";
import {
  type RunClaimClient,
  type ClaimOutcome,
  type FinishOutcome,
  type RunnerHttpError,
} from "./claim.js";
import type { HeartbeatScheduler } from "./heartbeat.js";
import {
  type AgentProcess,
  type AgentResult,
  type ProcessSpawner,
  AgentSpawner,
  ChildProcessSpawner,
  STDERR_TRUNCATE_BYTES,
  STDOUT_TRUNCATE_BYTES,
} from "./spawn.js";
import {
  type BoardContext,
  type ColumnContext,
  hydrateContext,
  type TaskHydrator,
  type PromptContext,
  renderPrompt,
} from "./prompt.js";

/**
 * Comments posted on failure use this poster. The default wires the
 * existing `POST /api/v1/comments` endpoint; the loop module only sees
 * the abstract signature so tests can capture / fail at will.
 */
export interface FailureCommentPoster {
  postComment(taskId: string, body: string): Promise<void>;
}

export interface RunLoopOptions {
  config: RunnerConfig;
  runnerId: string;
  agentType: string;
  claimClient: RunClaimClient;
  spawner?: ProcessSpawner;
  heartbeat: HeartbeatScheduler;
  hydrator: TaskHydrator;
  commentPoster: FailureCommentPoster;
  /**
   * Override the agent spawner. When omitted we build a default
   * `AgentSpawner` from `config.agent` plus the supplied
   * `ProcessSpawner` (or `ChildProcessSpawner` in production).
   */
  agentSpawner?: AgentSpawner;
  /** Sleep injected so tests can advance fake timers deterministically. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Abort signal — when fired, the loop resolves with the in-flight state drained. */
  signal?: AbortSignal;
  /**
   * Optional controller paired with `signal`. When supplied the
   * loop calls `controller.abort()` from `requestShutdown()` so
   * collaborators that listen to the same signal (e.g. the
   * board watcher, which keeps a WebSocket reconnect timer
   * alive) tear down alongside the loop. Without this, --once
   * would leave the watcher retrying the WS handshake forever
   * and the Node event loop would stay alive past completion.
   */
  abortController?: AbortController;
  /** Logger — defaults to a no-op so production callers stay terse. */
  logger?: RunLoopLogger;
  /**
   * Override the comment that is appended to the task on failure.
   * Defaults to a multi-line block that includes the exit code and
   * the truncated stderr.
   */
  buildFailureComment?: (task: TaskRecord, result: AgentResult, context: { runnerId: string }) => string;
}

export interface RunLoopLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /**
   * Verbose trace for operators running with `--debug`. Production
   * implementations can no-op this when debug mode is off so the
   * default log volume is unchanged for regular operators.
   */
  debug(msg: string): void;
}

const NULL_LOGGER: RunLoopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Outcome of `runLoop` — the loop resolves with this object so callers
 * (CLI entry, tests) can surface a meaningful exit message.
 */
export interface RunLoopSummary {
  processed: number;
  completed: number;
  failed: number;
  shutdown: boolean;
}

/**
 * Maximum stderr payload we forward to the server. The server already
 * documents a 64 KiB cap; we mirror it client-side so a runaway agent
 * cannot OOM the CLI.
 */
const MAX_STDERR_FORWARD = STDERR_TRUNCATE_BYTES;

/**
 * Maximum stdout payload we forward to the server. Mirrors
 * `MAX_STDERR_FORWARD`; the server's `task_runs.output` column
 * was added in s-1185 with the same 64 KiB cap.
 */
const MAX_STDOUT_FORWARD = STDOUT_TRUNCATE_BYTES;

export class RunLoop {
  private readonly opts: RunLoopOptions;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: RunLoopLogger;
  private readonly agentSpawner: AgentSpawner;
  private readonly claimClient: RunClaimClient;
  private readonly hydrator: TaskHydrator;
  private readonly commentPoster: FailureCommentPoster;
  private readonly config: RunnerConfig;
  private readonly runnerId: string;
  private readonly agentType: string;
  private readonly heartbeat: HeartbeatScheduler;
  private readonly abortController: AbortController | undefined;

  private inFlight: InFlightTask | null = null;
  private processed = 0;
  private completed = 0;
  private failed = 0;
  private shutdown = false;
  private nextClaimDelay: number | null = null;
  private heartbeatDeadline: number | null = null;
  private wakePending = false;
  private currentSleepReject: ((reason: Error) => void) | null = null;

  constructor(opts: RunLoopOptions) {
    this.opts = opts;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.logger = opts.logger ?? NULL_LOGGER;
    if (opts.agentSpawner) {
      this.agentSpawner = opts.agentSpawner;
    } else {
      const spawnerImpl = opts.spawner ?? new ChildProcessSpawner({ timeoutMs: opts.config.agent.timeoutMs ?? 1_800_000 });
      this.agentSpawner = new AgentSpawner(opts.config.agent, spawnerImpl);
    }
    this.claimClient = opts.claimClient;
    this.hydrator = opts.hydrator;
    this.commentPoster = opts.commentPoster;
    this.config = opts.config;
    this.runnerId = opts.runnerId;
    this.agentType = opts.agentType;
    this.heartbeat = opts.heartbeat;
    this.abortController = opts.abortController;
    if (opts.signal) {
      const onAbort = (): void => {
        this.shutdown = true;
      };
      if (opts.signal.aborted) {
        this.shutdown = true;
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  }

  /**
   * Request a graceful shutdown. The current in-flight task (if any)
   * is sent SIGTERM and the loop resolves on the next tick.
   *
   * Also aborts the supplied signal so collaborators that listen
   * to it (e.g. the board watcher in `startBoardWatcherIfPossible`,
   * which keeps a WebSocket reconnect timer alive) tear down
   * alongside the loop. Without this, --once would leave the
   * watcher retrying the WS handshake forever and keep the
   * Node event loop alive after the task had been processed.
   */
  requestShutdown(): void {
    this.shutdown = true;
    // Wake the loop out of its idle sleep so SIGINT/SIGTERM
    // handlers don't have to wait for the full pollInterval.
    this.interruptSleep(new Error("shutdown requested"));
    // Cascade the abort so the watcher closes its WS handle and
    // cancels its reconnect timer. The loop's own abort listener
    // (which just re-sets shutdown=true) is a no-op here, so this
    // is safe to call even when shutdown was driven by signal.
    this.abortController?.abort();
  }

  /**
   * Signal that the runner should re-evaluate the queue right
   * now. Used by the WebSocket subscription (s-1130) so a
   * freshly-created task reaches the runner without waiting
   * for the next `pollIntervalMs` tick. The flag is sticky:
   * even if the loop is mid-sleep when `wake()` is called, the
   * pending flag survives until the next tick consumes it.
   */
  wake(): void {
    this.wakePending = true;
    this.logger.debug("wake() called; pending fast-poll on next tick");
    this.interruptSleep(new Error("wake"));
  }

  /**
   * Abort the in-flight idle sleep so a `wake()` /
   * `requestShutdown()` propagates immediately. The reject is
   * swallowed by `sleep()` and converted into a no-op; the
   * wakePending flag (or the shutdown flag) is what the loop
   * actually consults on the next tick.
   */
  private interruptSleep(reason: Error): void {
    const reject = this.currentSleepReject;
    if (reject) {
      this.currentSleepReject = null;
      try {
        reject(reason);
      } catch {
        // never let a wake() kill the loop
      }
    }
  }

  /** Snapshot of the loop state — for tests + the CLI final report. */
  get state(): { inFlight: InFlightTask | null; processed: number; completed: number; failed: number; shutdown: boolean } {
    return {
      inFlight: this.inFlight,
      processed: this.processed,
      completed: this.completed,
      failed: this.failed,
      shutdown: this.shutdown,
    };
  }

  /**
   * Drive the loop until `shutdown` is requested. The function returns
   * a `RunLoopSummary` so callers can render a final report.
   */
  async run(): Promise<RunLoopSummary> {
    this.logger.info(`runner ${this.runnerId} starting`);
    this.logger.debug(
      `loop config: mode=${this.config.mode ?? "board"} boardId=${this.config.boardId ?? "(none)"} status=${this.config.status ?? "(none)"} agentType=${this.agentType} pollIntervalMs=${this.config.runner.pollIntervalMs} heartbeatIntervalMs=${this.config.runner.heartbeatIntervalMs ?? 30_000}`
    );
    while (!this.shutdown) {
      if (this.inFlight) {
        await this.watchInFlight();
        if (this.shutdown) break;
        continue;
      }
      await this.tryClaim();
      if (this.shutdown) break;
      if (!this.inFlight) {
        const delay = this.computeNextDelay();
        this.logger.debug(`no task claimed; sleeping ${delay}ms`);
        await this.sleepInterruptible(delay);
      }
    }
    await this.gracefulShutdown();
    return {
      processed: this.processed,
      completed: this.completed,
      failed: this.failed,
      shutdown: this.shutdown,
    };
  }

  /**
   * Single-tick variant — for tests that want to advance the state
   * machine one step at a time. Mirrors `run()`'s post-loop
   * behaviour: once shutdown has been requested we always invoke
   * `gracefulShutdown()` so the runner releases any orphan locks.
   */
  async tick(): Promise<boolean> {
    if (this.shutdown) {
      await this.gracefulShutdown();
      return false;
    }
    if (this.inFlight) {
      await this.watchInFlight();
      return !this.shutdown;
    }
    await this.tryClaim();
    if (this.shutdown) {
      await this.gracefulShutdown();
      return false;
    }
    if (!this.inFlight) {
      const delay = this.computeNextDelay();
      await this.sleepInterruptible(delay);
    }
    return !this.shutdown;
  }

  /**
   * Resolve the delay for the next idle sleep, honouring the
   * `wake()` shortcut. When a wake-up is pending we sleep
   * "zero-ish" (still yields the event loop) so the loop spins
   * up against the live WS event without thrashing CPU.
   */
  private computeNextDelay(): number {
    if (this.wakePending) {
      this.wakePending = false;
      // Honour a pending back-off override (set by tryClaim on
      // transient errors) but floor it at 1ms so the wake
      // doesn't deadlock against an infinite back-off.
      const override = this.nextClaimDelay ?? 0;
      this.nextClaimDelay = null;
      return Math.min(Math.max(override, 0), 50);
    }
    const delay = this.nextClaimDelay ?? this.config.runner.pollIntervalMs;
    this.nextClaimDelay = null;
    return delay;
  }

  /**
   * Sleep that can be aborted early by `wake()` /
   * `requestShutdown()`. The reject is swallowed so the
   * interrupt is invisible to the run loop — the next iteration
   * consults the wake flag / shutdown flag naturally.
   */
  private async sleepInterruptible(ms: number): Promise<void> {
    if (this.shutdown) return;
    if (ms <= 0) {
      // Yield once so the event loop can deliver pending
      // microtasks (notably the WS message queue) before we
      // immediately re-poll.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.currentSleepReject = null;
          resolve();
        }, ms);
        if (this.currentSleepReject) {
          // Defensive: a previous sleep left a reject handler
          // dangling. Clear it before installing ours.
          this.currentSleepReject(new Error("superseded"));
        }
        this.currentSleepReject = (reason: Error) => {
          clearTimeout(timer);
          reject(reason);
        };
      });
    } catch {
      // Expected: a wake()/shutdown rejected the sleep. The
      // run loop will observe the corresponding flag on the
      // next iteration.
    }
  }

  private async tryClaim(): Promise<void> {
    this.logger.debug(
      `claim attempt: boardId=${this.config.boardId ?? "(none)"} status=${this.config.status ?? "(none)"} mode=${this.config.mode === "mine" ? "mine" : "board"}`
    );
    let outcome: ClaimOutcome;
    try {
      outcome = await this.claimClient.claim({
        boardId: this.config.boardId ?? "",
        status: this.config.status ?? "",
        agentType: this.agentType,
        runnerId: this.runnerId,
        mode: this.config.mode === "mine" ? "mine" : "board",
      });
    } catch (err) {
      const retryable = (err as RunnerHttpError).retryable;
      this.logger.error(
        `claim failed: ${(err as Error).message} (retryable=${retryable})`
      );
      this.logger.debug(
        `claim error stack: ${(err as Error).stack ?? "(no stack)"}`
      );
      if (!retryable) {
        this.requestShutdown();
        return;
      }
      this.nextClaimDelay = backoff(this.config.runner.pollIntervalMs);
      this.logger.debug(`backing off ${this.nextClaimDelay}ms before next claim`);
      return;
    }
    if (outcome.kind === "none") {
      this.logger.debug("claim returned 204/no-content (idle)");
      return;
    }
    const { task } = outcome;
    if (!task.id) {
      this.logger.warn("server returned a claim with no task id; skipping");
      return;
    }
    this.logger.debug(
      `claim succeeded: taskId=${task.id} title=${task.title ?? "(untitled)"} columnId=${task.columnId ?? "(unknown)"} priority=${task.priority ?? "(unset)"}`
    );
    await this.startTask(task);
  }

  private async startTask(task: TaskRecord): Promise<void> {
    this.logger.info(`claimed task ${task.id} (${task.title ?? "(untitled)"})`);
    let ctx: PromptContext;
    try {
      ctx = await hydrateContext(this.hydrator, task, {
        boardId: this.config.boardId,
        columnId: task.columnId,
      });
      this.logger.debug(
        `hydrated task ${task.id}: board=${ctx.board.name} column=${ctx.column.name} comments=${ctx.comments.length} subtasks=${ctx.subtasks.length}`
      );
    } catch (err) {
      this.logger.error(
        `failed to hydrate task ${task.id}: ${(err as Error).message}`
      );
      ctx = {
        board: { id: this.config.boardId ?? "", name: this.config.boardId ?? "(unknown board)" },
        column: { id: task.columnId ?? "", name: task.columnId ?? "(unknown column)" },
        task,
        comments: [],
        subtasks: [],
      };
    }
    const prompt = renderPrompt(ctx);
    this.logger.debug(
      `spawning agent for task ${task.id}: bin=${this.config.agent.bin} timeoutMs=${this.config.agent.timeoutMs ?? 1_800_000} promptBytes=${prompt.length}`
    );
    const { process: child, cleanup } = this.agentSpawner.spawn({
      cfg: this.config.agent,
      prompt,
      taskId: task.id,
      variables: buildArgVariables(ctx),
    });
    this.logger.debug(`agent spawned for task ${task.id} pid=${child.pid ?? "(unknown)"}`);
    this.inFlight = {
      taskId: task.id,
      task,
      child,
      cleanup,
      prompt,
      waitPromise: child.wait(),
    };
    this.heartbeat.start(task.id);
    this.heartbeatDeadline =
      Date.now() + (this.config.runner.heartbeatIntervalMs ?? 30_000);
  }

  private async watchInFlight(): Promise<void> {
    const slot = this.inFlight;
    if (!slot) return;
    if (
      this.heartbeatDeadline !== null &&
      Date.now() >= this.heartbeatDeadline
    ) {
      await this.heartbeat.tickNow();
      this.heartbeatDeadline =
        Date.now() + (this.config.runner.heartbeatIntervalMs ?? 30_000);
    }
    // Race the waitPromise against a setTimeout(0) tick so the event
    // loop has a chance to deliver a resolved child promise before we
    // declare the slot still in-flight.
    //
    // Why setTimeout(0) and not setImmediate: setImmediate fires in
    // the "check" phase AFTER the poll phase, which sounds right in
    // theory, but a hot loop that keeps scheduling setImmediates can
    // starve the poll phase of I/O events — the agent's close event
    // never gets a chance to land. setTimeout(0) fires in the
    // "timers" phase BEFORE poll, which forces the loop to run I/O
    // first. The race is still "one tick" of the event loop, so the
    // cost is identical; we just guarantee that close events get a
    // chance to resolve waitPromise on the same tick.
    const settled = await new Promise<boolean>((resolve) => {
      let done = false;
      slot.waitPromise.then(
        () => {
          if (!done) {
            done = true;
            resolve(true);
          }
        },
        () => {
          if (!done) {
            done = true;
            resolve(true);
          }
        }
      );
      setTimeout(() => {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, 0);
    });
    if (!settled) return;
    const result = await slot.waitPromise;
    this.heartbeat.stop();
    this.inFlight = null;
    this.heartbeatDeadline = null;
    slot.cleanup();
    await this.handleResult(slot.task, result);
    this.processed++;
  }

  private async handleResult(task: TaskRecord, result: AgentResult): Promise<void> {
    this.logger.debug(
      `agent finished for task ${task.id}: exitCode=${result.exitCode ?? "(none)"} signal=${result.signal ?? "(none)"} reason=${result.reason}`
    );
    const ok = result.exitCode === 0 && result.reason === "exit";
    if (ok) {
      const finish = await this.finishTask(task, "completed", result);
      if (finish.kind === "ok") {
        this.completed++;
        this.logger.info(`task ${task.id} completed`);
      } else {
        this.failed++;
        this.logger.warn(
          `task ${task.id} finish returned 409 (lost); counting as failure`
        );
      }
      return;
    }
    await this.postFailureComment(task, result);
    const finish = await this.finishTask(task, "failed", result);
    this.failed++;
    if (finish.kind !== "ok") {
      this.logger.warn(
        `task ${task.id} finish(failed) returned 409; comment was already posted`
      );
    }
  }

  private async postFailureComment(task: TaskRecord, result: AgentResult): Promise<void> {
    const taskId = task.id ?? "";
    if (!taskId) {
      this.logger.warn(
        `cannot post failure comment: task has no id (exitCode=${result.exitCode ?? "(none)"} signal=${result.signal ?? "(none)"} reason=${result.reason})`
      );
      return;
    }
    const context = { runnerId: this.runnerId };
    const builder = this.opts.buildFailureComment ?? defaultBuildFailureComment;
    const raw = builder(task, result, context);
    // Guard against an empty body — the /api/v1/comments endpoint
    // requires a non-empty `content` field and would otherwise reject
    // the POST with a 400. Fall back to the default builder (which
    // always emits at least the runner id, exit code, and reason)
    // when the supplied builder returned an empty / whitespace-only
    // string. Operators overriding the builder for fancy formatting
    // therefore cannot accidentally drop the comment.
    const body = raw.trim().length > 0
      ? raw
      : defaultBuildFailureComment(task, result, context);
    try {
      await this.commentPoster.postComment(taskId, body);
    } catch (err) {
      this.logger.warn(
        `failed to post failure comment for ${taskId}: ${(err as Error).message}`
      );
    }
  }

  private async finishTask(
    task: TaskRecord,
    status: "completed" | "failed",
    result: AgentResult
  ): Promise<FinishOutcome> {
    try {
      return await this.claimClient.finish(task.id ?? "", {
        runnerId: this.runnerId,
        status,
        exitCode: result.exitCode,
        // s-1185: send the agent's stdout under `output` so the
        // task detail page can show what the agent actually
        // produced. The `error` field is reserved for true
        // failure context (non-zero exit, signal, spawn error).
        error: truncateForForward(result.stderr, MAX_STDERR_FORWARD),
        output: truncateForForward(result.stdout, MAX_STDOUT_FORWARD),
      });
    } catch (err) {
      this.logger.error(
        `finish(${status}) for ${task.id} threw: ${(err as Error).message}`
      );
      return { kind: "conflict" };
    }
  }

  private async gracefulShutdown(): Promise<void> {
    const slot = this.inFlight;
    if (slot) {
      this.logger.info(`shutdown requested; draining task ${slot.taskId}`);
      this.heartbeat.stop();
      try {
        slot.child.kill("SIGTERM");
      } catch {
        // already dead
      }
      const drain = await Promise.race<AgentResult | "timeout">([
        slot.waitPromise,
        this.sleep(15_000).then(() => "timeout" as const),
      ]);
      const result: AgentResult = drain === "timeout"
        ? {
            exitCode: null,
            signal: "SIGTERM",
            stderr: "",
            stdout: "",
            reason: "signal",
          }
        : drain;
      slot.cleanup();
      this.inFlight = null;
      await this.postFailureComment(slot.task, result);
      await this.finishTask(slot.task, "failed", result);
      this.failed++;
    }
    try {
      await this.claimClient.release({ runnerId: this.runnerId });
    } catch (err) {
      this.logger.warn(
        `release on shutdown threw: ${(err as Error).message}`
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.sleepFn(ms);
  }
}

interface InFlightTask {
  taskId: string;
  task: TaskRecord;
  child: AgentProcess;
  cleanup: () => void;
  prompt: string;
  waitPromise: Promise<AgentResult>;
}

/**
 * Build the `$name` substitution table from the hydrated task
 * context. Used by `agentSpawner.spawn` so an operator's
 * `agent.args` (e.g. `["--task=$taskId", "--title=$title"]`) renders
 * with the actual task data.
 *
 * Empty strings are returned for unset fields (no title, no
 * assignee) rather than `undefined` so the spawn layer can splice
 * them verbatim — a missing `--title=` flag is the convention most
 * CLI agents use to signal "absent", whereas dropping the flag
 * entirely would shift every subsequent flag's index and break the
 * operator's argv layout.
 */
function buildArgVariables(ctx: PromptContext): Partial<ArgVariableValues> {
  const t = ctx.task;
  return {
    taskId: t.id ?? "",
    title: t.title ?? "",
    body: t.description ?? "",
    priority: t.priority == null ? "" : String(t.priority),
    assignee: t.assignee ?? "",
    columnId: t.columnId ?? ctx.column.id ?? "",
    boardId: ctx.board.id ?? "",
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default failure-comment formatter. Always returns a non-empty
 * string so the `/api/v1/comments` endpoint never sees a missing or
 * empty `content` field. Exported for unit tests and for callers that
 * want to compose their own builder on top of the default.
 */
export function defaultBuildFailureComment(
  task: TaskRecord,
  result: AgentResult,
  context: { runnerId: string }
): string {
  const lines: string[] = [];
  lines.push(`runner ${context.runnerId}: task failed`);
  if (task.title) lines.push(`title: ${task.title}`);
  lines.push(`exit code: ${result.exitCode ?? "(none)"}`);
  lines.push(`reason: ${result.reason}`);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  const stderr = (result.stderr ?? "").trim();
  if (stderr.length > 0) {
    lines.push("stderr:");
    lines.push(stderr);
  }
  return lines.join("\n");
}

function backoff(baseMs: number): number {
  return Math.max(baseMs, baseMs * 2);
}

function truncateForForward(text: string, max: number): string {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n[truncated]";
}

export type { TaskHydrator, BoardContext, ColumnContext };
