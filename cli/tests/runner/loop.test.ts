// Tests for `cli/src/runner/loop.ts` — the §4.2 state machine.
//
// The test harness drives the loop manually:
//
//   * A scripted `RunClaimClient` (via the `RunTransport` test seam)
//     returns 200 / 204 / 409 / 500 in the order we want.
//   * A fake `ProcessSpawner` returns processes that we resolve
//     deterministically (success / failure / hang).
//   * A fake `FailureCommentPoster` records the comments so we can
//     assert the failure path.
//   * A `HeartbeatScheduler` is wired with the same fake transport
//     so heartbeats round-trip the same script.
//
// The "5s / 3 happy tasks" acceptance criterion is verified by
// running three claims back-to-back with `tick()` and asserting the
// loop completes in well under 5 seconds of wall time (in practice
// milliseconds, since all sleeps / intervals are resolved
// deterministically).

import { afterEach, describe, expect, it } from "vitest";
import {
  type ClaimRequest,
  type HeartbeatOutcome,
  type RunTransport,
  RunClaimClient,
} from "../../src/runner/claim.js";
import { HeartbeatScheduler } from "../../src/runner/heartbeat.js";
import {
  type AgentProcess,
  type AgentResult,
  type ProcessSpawner,
  type SpawnOptions,
  STDERR_TRUNCATE_BYTES,
} from "../../src/runner/spawn.js";
import {
  type FailureCommentPoster,
  RunLoop,
  type RunLoopLogger,
  type TaskHydrator,
} from "../../src/runner/loop.js";
import type { TaskRecord } from "../../src/commands/tasks.js";
import type { RunnerConfig } from "../../src/runner/types.js";

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

interface ScriptedClaim {
  request: ClaimRequest;
  outcome: ScriptedResponse;
}

interface FakeClaimTransport {
  transport: RunTransport;
  scripts: ScriptedClaim[];
  claimCalls: { path: string; body: unknown }[];
  finishCalls: { path: string; body: unknown }[];
  releaseCalls: { path: string; body: unknown }[];
  heartbeatCalls: { path: string; body: unknown }[];
}

function makeClaimTransport(scripts: ScriptedClaim[]): FakeClaimTransport {
  const claimCalls: { path: string; body: unknown }[] = [];
  const finishCalls: { path: string; body: unknown }[] = [];
  const releaseCalls: { path: string; body: unknown }[] = [];
  const heartbeatCalls: { path: string; body: unknown }[] = [];
  let next = 0;
  const transport: RunTransport = {
    async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
      const route = path.startsWith("/runs/claim")
        ? "claim"
        : path.startsWith("/runs/release")
          ? "release"
          : path.endsWith("/finish")
            ? "finish"
            : path.endsWith("/heartbeat")
              ? "heartbeat"
              : "other";
      const recorded = { path, body };
      if (route === "claim") claimCalls.push(recorded);
      else if (route === "finish") finishCalls.push(recorded);
      else if (route === "release") releaseCalls.push(recorded);
      else if (route === "heartbeat") heartbeatCalls.push(recorded);
      if (route === "claim") {
        const script = scripts[Math.min(next, scripts.length - 1)];
        next++;
        return { status: script.outcome.status, body: script.outcome.body as T };
      }
      if (route === "release") {
        return { status: 200, body: { released: 0 } as T };
      }
      if (route === "heartbeat") {
        return { status: 200, body: { expiresAt: "2030-01-01T00:00:00Z" } as T };
      }
      // finish
      return { status: 200, body: { success: true, advanced: true } as T };
    },
  };
  return { transport, scripts, claimCalls, finishCalls, releaseCalls, heartbeatCalls };
}

interface FakeSpawnHandle {
  process: AgentProcess;
  finishWith: (result: AgentResult) => void;
}

interface FakeSpawner extends ProcessSpawner {
  spawn(opts: SpawnOptions): { process: AgentProcess; cleanup: () => void };
  calls: SpawnOptions[];
  handles: FakeSpawnHandle[];
  resolveNext: (result: AgentResult) => void;
  resolveIndex: (index: number, result: AgentResult) => void;
}

function makeFakeSpawner(): FakeSpawner {
  const calls: SpawnOptions[] = [];
  const handles: FakeSpawnHandle[] = [];
  let pendingResolve: ((r: AgentResult) => void) | null = null;
  const spawner: FakeSpawner = {
    calls,
    handles,
    resolveNext(result) {
      if (pendingResolve) {
        const fn = pendingResolve;
        pendingResolve = null;
        fn(result);
      }
    },
    resolveIndex(index, result) {
      const handle = handles[index];
      handle.finishWith(result);
    },
    spawn(opts: SpawnOptions) {
      calls.push(opts);
      let resolver: ((r: AgentResult) => void) | null = null;
      const waitPromise = new Promise<AgentResult>((resolve) => {
        resolver = resolve;
      });
      pendingResolve = resolver;
      const proc: AgentProcess = {
        kill: () => true,
        pid: 1000 + calls.length,
        wait: () => waitPromise,
      };
      const handle: FakeSpawnHandle = {
        process: proc,
        finishWith: (r) => resolver?.(r),
      };
      handles.push(handle);
      return { process: proc, cleanup: () => undefined };
    },
  };
  return spawner;
}

interface CapturedLog {
  level: "info" | "warn" | "error";
  message: string;
}

function makeLogger(): { logger: RunLoopLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info: (m) => logs.push({ level: "info", message: m }),
      warn: (m) => logs.push({ level: "warn", message: m }),
      error: (m) => logs.push({ level: "error", message: m }),
    },
  };
}

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    version: 1,
    boardId: "sys",
    status: "todo",
    agent: {
      bin: "opencode",
      promptMode: "arg",
      promptArg: "--prompt",
      timeoutMs: 5_000,
    },
    runner: {
      pollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      lockTimeoutMs: 30_000,
      maxConcurrent: 1,
      mode: "claim",
    },
    ...overrides,
    agent: { ...({ bin: "opencode" } as RunnerConfig["agent"]), ...overrides.agent },
    runner: { ...({} as RunnerConfig["runner"]), ...overrides.runner },
  };
}

const TASK_TEMPLATE: TaskRecord = {
  id: "s-1090",
  title: "Implement runner loop",
  agentPrompt: "follow the algorithm",
  columnId: "col-1",
  priority: "high",
};

function makeHydrator(): TaskHydrator {
  return {
    fetchComments: async () => [],
    fetchSubtasks: async () => [],
    fetchBoard: async () => ({ id: "sys", name: "Sys" }),
    fetchColumn: async () => ({ id: "col-1", name: "进行中" }),
    fetchTask: async () => TASK_TEMPLATE,
  };
}

interface LoopHarness {
  loop: RunLoop;
  transport: FakeClaimTransport;
  spawner: FakeSpawner;
  comments: { taskId: string; body: string }[];
  logger: RunLoopLogger;
  logs: CapturedLog[];
  noopSleep: (ms: number) => Promise<void>;
  noopInterval: (cb: () => void, ms: number) => unknown;
  noopClearInterval: (handle: unknown) => void;
  heartbeat: HeartbeatScheduler;
}

function makeHarness(opts: {
  config?: RunnerConfig;
  scripts?: ScriptedClaim[];
  runnerId?: string;
  signal?: AbortSignal;
} = {}): LoopHarness {
  const config = opts.config ?? makeConfig();
  const scripts = opts.scripts ?? [];
  const transport = makeClaimTransport(scripts);
  const claimClient = new RunClaimClient(transport.transport);
  const heartbeat = new HeartbeatScheduler(claimClient, opts.runnerId ?? "runner-1", {
    intervalMs: config.runner.heartbeatIntervalMs ?? 1_000,
    setIntervalFn: ((cb: () => void) => ({ unref: () => undefined, _cb: cb })) as unknown as (
      cb: () => void,
      ms: number
    ) => unknown,
    clearIntervalFn: () => undefined,
    nowFn: () => 1_000_000,
  });
  const spawner = makeFakeSpawner();
  const comments: { taskId: string; body: string }[] = [];
  const commentPoster: FailureCommentPoster = {
    async postComment(taskId: string, body: string) {
      comments.push({ taskId, body });
    },
  };
  const { logger, logs } = makeLogger();
  const noopSleep = async (): Promise<void> => undefined;
  const loop = new RunLoop({
    config,
    runnerId: opts.runnerId ?? "runner-1",
    agentType: "opencoder",
    claimClient,
    spawner,
    heartbeat,
    hydrator: makeHydrator(),
    commentPoster,
    sleepFn: noopSleep,
    logger,
    signal: opts.signal,
  });
  return {
    loop,
    transport,
    spawner,
    comments,
    logger,
    logs,
    noopSleep,
    noopInterval: ((cb: () => void) => ({ unref: () => undefined, _cb: cb })) as unknown as (
      cb: () => void,
      ms: number
    ) => unknown,
    noopClearInterval: () => undefined,
    heartbeat,
  };
}

const NOOP_SCRIPTED: ScriptedClaim = {
  request: {
    boardId: "sys",
    status: "todo",
    agentType: "opencoder",
    runnerId: "runner-1",
  },
  outcome: { status: 204 },
};

afterEach(() => {
  // nothing to clean up
});

describe("RunLoop — happy path", () => {
  it("completes three tasks in well under 5 seconds", async () => {
    const claimTask = (id: string): ScriptedClaim => ({
      request: {
        boardId: "sys",
        status: "todo",
        agentType: "opencoder",
        runnerId: "runner-1",
      },
      outcome: {
        status: 200,
        body: {
          task: { ...TASK_TEMPLATE, id },
          run: { taskId: id, runnerId: "runner-1", status: "claimed" },
        },
      },
    });
    const h = makeHarness({
      scripts: [
        claimTask("s-1"),
        claimTask("s-2"),
        claimTask("s-3"),
      ],
    });
    const started = Date.now();
    // Step 1: tick to claim s-1 and spawn the agent.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.handles).toHaveLength(1);
    // Step 2: resolve s-1's child, tick to drain (finish s-1).
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.transport.finishCalls).toHaveLength(1);
    // Step 3: tick again to claim s-2 + spawn.
    more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.handles).toHaveLength(2);
    // Step 4: resolve s-2, tick to drain (finish s-2) → next claim.
    h.spawner.resolveIndex(1, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    await h.loop.tick(); // drain finish s-2
    await h.loop.tick(); // claim s-3 + spawn
    expect(h.spawner.handles).toHaveLength(3);
    // Step 5: resolve s-3, drain (finish s-3) BEFORE shutdown so the
    // loop sees it as a normal completion rather than a SIGTERM drain.
    h.spawner.resolveIndex(2, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    await h.loop.tick(); // drain finish s-3
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick(); // shutdown
    expect(finalTick).toBe(false);
    const elapsed = Date.now() - started;
    expect(h.loop.state.completed).toBe(3);
    expect(h.loop.state.failed).toBe(0);
    expect(h.loop.state.processed).toBe(3);
    expect(elapsed).toBeLessThan(5_000);
    expect(h.transport.finishCalls.map((c) => c.body)).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    // 3 spawns + 3 finishes + 1 release on shutdown.
    expect(h.spawner.calls).toHaveLength(3);
    expect(h.transport.releaseCalls).toHaveLength(1);
  });

  it("calls finish('completed') when the child exits with code 0", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
        NOOP_SCRIPTED,
      ],
    });
    // Tick once to advance through claim + spawn deterministically.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.handles).toHaveLength(1);
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    // Tick again to flush finish(completed); the loop then tries
    // the next claim which returns 204 → idle → no shutdown yet.
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(h.loop.state.completed).toBe(1);
    expect(h.transport.finishCalls).toHaveLength(1);
    expect(h.transport.finishCalls[0].body).toMatchObject({
      status: "completed",
      exitCode: 0,
      runnerId: "runner-1",
    });
  });
});

describe("RunLoop — failure path", () => {
  it("posts a comment and calls finish('failed') on non-zero exit", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    // Tick to claim + spawn, then resolve the child with a non-zero exit.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.handles).toHaveLength(1);
    h.spawner.resolveIndex(0, {
      exitCode: 2,
      signal: null,
      stderr: "boom",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(h.loop.state.completed).toBe(0);
    expect(h.loop.state.failed).toBe(1);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].taskId).toBe(TASK_TEMPLATE.id);
    expect(h.comments[0].body).toContain("exit code: 2");
    expect(h.comments[0].body).toContain("stderr:");
    expect(h.comments[0].body).toContain("boom");
    expect(h.transport.finishCalls[0].body).toMatchObject({
      status: "failed",
      exitCode: 2,
    });
  });

  it("truncates the forwarded stderr to 64 KiB", async () => {
    const huge = "X".repeat(80 * 1024);
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    let more = await h.loop.tick();
    expect(more).toBe(true);
    h.spawner.resolveIndex(0, {
      exitCode: 1,
      signal: null,
      stderr: huge,
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    await h.loop.tick();
    const forwarded = (h.transport.finishCalls[0].body as { error?: string }).error ?? "";
    expect(forwarded.length).toBeLessThanOrEqual(STDERR_TRUNCATE_BYTES + "[truncated]".length + 5);
    expect(forwarded.endsWith("[truncated]")).toBe(true);
  });

  it("counts the task as failed when finish returns 409 (lock lost)", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    // Override the transport so finish returns 409.
    const originalPost = h.transport.transport.postJson;
    h.transport.transport.postJson = async function <T>(
      path: string,
      body: unknown
    ): Promise<{ status: number; body: T | null }> {
      if (path.endsWith("/finish")) return { status: 409, body: null };
      return originalPost.call(h.transport.transport, path, body) as Promise<{
        status: number;
        body: T | null;
      }>;
    };
    let more = await h.loop.tick();
    expect(more).toBe(true);
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(h.loop.state.failed).toBe(1);
    expect(h.loop.state.completed).toBe(0);
  });
});

describe("RunLoop — claim semantics", () => {
  it("treats 204 as 'no task available' and does not spawn", async () => {
    const h = makeHarness({ scripts: [NOOP_SCRIPTED, NOOP_SCRIPTED] });
    let more = await h.loop.tick();
    expect(more).toBe(true);
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(h.loop.state.processed).toBe(0);
    expect(h.transport.claimCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.spawner.calls).toHaveLength(0);
  });

  it("fails closed on a 409 claim (non-retryable)", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: { status: 409, body: { error: "permission denied" } },
        },
      ],
    });
    const summary = await h.loop.run();
    expect(summary.processed).toBe(0);
    expect(h.transport.claimCalls).toHaveLength(1);
    expect(h.spawner.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });
});

describe("RunLoop — graceful shutdown", () => {
  it("drains the in-flight task on SIGTERM and posts a failure comment", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    // Tick once to claim + spawn s-1090.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.handles).toHaveLength(1);
    // Simulate SIGTERM: kill the child and let it resolve with SIGTERM.
    h.spawner.resolveIndex(0, {
      exitCode: null,
      signal: "SIGTERM",
      stderr: "",
      reason: "signal",
    });
    h.loop.requestShutdown();
    // Tick once more — shutdown → gracefulShutdown drains the slot.
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(h.loop.state.shutdown).toBe(true);
    expect(h.loop.state.failed).toBe(1);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].body).toContain("signal: SIGTERM");
    expect(h.transport.releaseCalls).toHaveLength(1);
    expect(h.transport.releaseCalls[0].body).toEqual({
      runnerId: "runner-1",
      taskIds: null,
    });
  });

  it("releases the runner's locks on shutdown when nothing is in flight", async () => {
    const h = makeHarness({ scripts: [NOOP_SCRIPTED] });
    let more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    await h.loop.tick();
    expect(h.transport.releaseCalls).toHaveLength(1);
  });
});

describe("RunLoop — tick() single-step driver", () => {
  it("returns false once shutdown has been requested", async () => {
    const h = makeHarness({ scripts: [NOOP_SCRIPTED] });
    h.loop.requestShutdown();
    const more = await h.loop.tick();
    expect(more).toBe(false);
  });

  it("drives idle → claim → spawn → heartbeat → exit → finish in sequence", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    // Tick 1: claim + spawn.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.calls).toHaveLength(1);
    // Tick 2: still in-flight (child not resolved yet), nothing to do.
    more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.spawner.calls).toHaveLength(1);
    // Resolve the child and tick again: finish + claim attempt.
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    expect(h.transport.finishCalls).toHaveLength(1);
    // Request shutdown so the next tick returns false.
    h.loop.requestShutdown();
    more = await h.loop.tick();
    expect(more).toBe(false);
  });
});

describe("RunLoop — heartbeat integration", () => {
  it("drives a heartbeat tick before exit handling", async () => {
    const events: HeartbeatOutcome[] = [];
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: {
            status: 200,
            body: {
              task: TASK_TEMPLATE,
              run: { taskId: TASK_TEMPLATE.id, runnerId: "runner-1" },
            },
          },
        },
      ],
    });
    h.heartbeat.onTick((r) => events.push(r.outcome));
    // Tick once to spawn the agent.
    let more = await h.loop.tick();
    expect(more).toBe(true);
    // Trigger a heartbeat tick explicitly via the scheduler — the
    // scheduler checks currentTask so the tick round-trips through
    // the fake transport.
    await h.heartbeat.tickNow();
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    // Tick drains the in-flight task and finishes.
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    expect(events.some((e) => e.kind === "ok")).toBe(true);
  });
});
