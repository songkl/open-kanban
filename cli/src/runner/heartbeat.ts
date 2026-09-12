// In-flight heartbeat scheduler — §4.2 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// The runner owns at most one in-flight task. While the agent process
// is running, the runner must call `POST /runs/:taskId/heartbeat` on a
// fixed cadence so the server-side lock does not expire. Two design
// decisions drive this module:
//
//   1. The scheduler is **explicitly controlled** by the loop, not
//      autonomous. We expose `start()` / `stop()` so the loop can
//      align the heartbeat with the rest of the state machine; an
//      autonomous timer would race with `finish()` on the trailing
//      edge.
//   2. The timer primitive is **injectable**. Production code uses the
//      real `setInterval` / `clearInterval`; the loop tests use
//      vitest's fake timers. We also accept a custom `nowFn` so a
//      test can advance "wall clock" without touching the timer queue.
//
// The actual HTTP call lives in `claim.ts` (`RunClaimClient.heartbeat`);
// this module is responsible only for the *when*.

import type { RunClaimClient, HeartbeatOutcome } from "./claim.js";

export interface HeartbeatSchedulerOptions {
  /** Heartbeat cadence in milliseconds. */
  intervalMs: number;
  /** Source of "now"; injectable so tests can advance time deterministically. */
  nowFn?: () => number;
  /** Timer factory; injectable so tests can use vitest's fake timers. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Outcome the loop sees when a heartbeat round-trip fails. The loop
 * uses this to decide whether to abandon the task (`lost` from 409)
 * or simply retry on the next tick (`ok` with `retryable=false`).
 */
export interface HeartbeatTickResult {
  outcome: HeartbeatOutcome;
  error?: unknown;
}

export class HeartbeatScheduler {
  private readonly client: RunClaimClient;
  private readonly runnerId: string;
  private readonly intervalMs: number;
  private readonly nowFn: () => number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private handle: unknown = null;
  private currentTaskId: string | null = null;
  private listeners: Array<(r: HeartbeatTickResult) => void> = [];
  private inFlight = false;

  constructor(client: RunClaimClient, runnerId: string, opts: HeartbeatSchedulerOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error(`HeartbeatScheduler: intervalMs must be a positive number, got ${opts.intervalMs}`);
    }
    this.client = client;
    this.runnerId = runnerId;
    this.intervalMs = opts.intervalMs;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms) as unknown);
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /**
   * Subscribe to tick outcomes. The same callback is invoked for
   * success and error paths so the loop can log uniformly.
   */
  onTick(cb: (r: HeartbeatTickResult) => void): void {
    this.listeners.push(cb);
  }

  /** Begin heartbeating the supplied task. No-op when already started. */
  start(taskId: string): void {
    if (this.handle !== null && this.currentTaskId === taskId) return;
    this.stop();
    this.currentTaskId = taskId;
    this.handle = this.setIntervalFn(() => {
      void this.fire();
    }, this.intervalMs);
  }

  /**
   * Stop heartbeating. Safe to call when no schedule is active.
   */
  stop(): void {
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
    this.currentTaskId = null;
  }

  /**
   * Fire a heartbeat round-trip immediately. The loop can call this
   * from its main tick instead of waiting for the timer to ensure the
   * very first heartbeat happens close to claim time.
   */
  async tickNow(): Promise<HeartbeatTickResult> {
    return this.fire();
  }

  /** Identifier of the task currently being heartbeated, or `null`. */
  get currentTask(): string | null {
    return this.currentTaskId;
  }

  /** Whether the scheduler has an active interval. */
  get active(): boolean {
    return this.handle !== null;
  }

  /** Current time according to the injected clock. */
  now(): number {
    return this.nowFn();
  }

  private async fire(): Promise<HeartbeatTickResult> {
    if (!this.currentTaskId) {
      return { outcome: { kind: "ok", expiresAt: "" } };
    }
    if (this.inFlight) {
      return { outcome: { kind: "ok", expiresAt: "" } };
    }
    this.inFlight = true;
    try {
      const outcome = await this.client.heartbeat(this.currentTaskId, this.runnerId);
      const result: HeartbeatTickResult = { outcome };
      this.dispatch(result);
      return result;
    } catch (err) {
      const result: HeartbeatTickResult = {
        outcome: { kind: "lost" },
        error: err,
      };
      this.dispatch(result);
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  private dispatch(result: HeartbeatTickResult): void {
    for (const cb of this.listeners) {
      try {
        cb(result);
      } catch {
        // best-effort listener; the loop test verifies individual paths
      }
    }
  }
}
