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
  defaultBuildFailureComment,
  RunLoop,
  type RunLoopLogger,
  type RunLoopOptions,
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
  level: "info" | "warn" | "error" | "debug";
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
      debug: (m) => logs.push({ level: "debug", message: m }),
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
  abortController?: AbortController;
  buildFailureComment?: RunLoopOptions["buildFailureComment"];
  hydrator?: TaskHydrator;
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
    hydrator: opts.hydrator ?? makeHydrator(),
    commentPoster,
    sleepFn: noopSleep,
    logger,
    signal: opts.signal,
    abortController: opts.abortController,
    buildFailureComment: opts.buildFailureComment,
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

describe("defaultBuildFailureComment (s-1164)", () => {
  it("always returns a non-empty body so the API never sees empty content", () => {
    const ctx = { runnerId: "runner-1" };
    const emptyResult: AgentResult = {
      exitCode: null,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    };
    const body = defaultBuildFailureComment(
      { id: "t-1", title: "", columnId: "c-1" } as TaskRecord,
      emptyResult,
      ctx,
    );
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).toContain("runner runner-1: task failed");
    expect(body).toContain("exit code: (none)");
    expect(body).toContain("reason: exit");
  });

  it("includes the exit code, signal, stderr, and title when present", () => {
    const body = defaultBuildFailureComment(
      { id: "t-1", title: "ship the thing", columnId: "c-1" } as TaskRecord,
      {
        exitCode: 1,
        signal: "SIGTERM",
        stderr: "  boom\n",
        stdout: "",
        reason: "exit",
      },
      { runnerId: "runner-7" },
    );
    expect(body).toContain("title: ship the thing");
    expect(body).toContain("exit code: 1");
    expect(body).toContain("signal: SIGTERM");
    expect(body).toContain("stderr:");
    expect(body).toContain("boom");
  });
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
      stdout: "",
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
      stdout: "",
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
      stdout: "",
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
      stdout: "",
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

  // s-1185: the runner previously discarded stdout entirely, so the
  // task detail page showed the agent's stderr banner as the
  // "Error" field. Verify the agent's actual reply now reaches
  // the server as `output` on the finish request.
  it("forwards the agent's stdout to the server under `output`", async () => {
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
    let more = await h.loop.tick();
    expect(more).toBe(true);
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "opencode build · v1.2.3\n",
      stdout: "Patched file X\nDone.\n",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    await h.loop.tick();
    expect(h.transport.finishCalls).toHaveLength(1);
    const body = h.transport.finishCalls[0].body as {
      status: string;
      output?: string;
      error?: string;
    };
    expect(body.status).toBe("completed");
    expect(body.output).toBe("Patched file X\nDone.\n");
    // The stderr banner stays in `error` so the UI can still
    // surface it; it just no longer masquerades as the agent's
    // actual reply (s-1185 separation).
    expect(body.error).toBe("opencode build · v1.2.3\n");
  });

  // s-1185: a successful run with non-empty stderr must NOT
  // populate `error` on the server — the UI used to display
  // that as "Error" / "错误信息" and confuse operators.
  // With the new shape `error` is the forwarded stderr verbatim
  // and `output` is the agent's stdout, and the success path
  // is the only thing that determines whether the row is
  // stamped `completed` vs `failed`.
  it("does not collapse stdout and stderr into the same field on success", async () => {
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
    let more = await h.loop.tick();
    expect(more).toBe(true);
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "opencode build · v1.2.3\n",
      stdout: "All tests pass.\n",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    await h.loop.tick();
    const body = h.transport.finishCalls[0].body as {
      status: string;
      output?: string;
      error?: string;
    };
    expect(body.status).toBe("completed");
    expect(body.output).toBe("All tests pass.\n");
    expect(body.error).toBe("opencode build · v1.2.3\n");
    // The two payloads must be distinct strings — the whole
    // point of s-1185 is that "where did the agent say" is
    // separate from "what did the agent warn about".
    expect(body.output).not.toBe(body.error);
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
      stdout: "",
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
      stdout: "",
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

  it("falls back to defaultBuildFailureComment when a custom builder returns empty (s-1164)", async () => {
    // s-1164: a custom builder that returns "" would otherwise cause
    // the POST /api/v1/comments call to be rejected with 400 because
    // the server's CreateComment handler requires non-empty content.
    const calls: { task: TaskRecord; result: AgentResult; runnerId: string }[] = [];
    const h = makeHarness({
      buildFailureComment: (task, result, ctx) => {
        calls.push({ task, result, runnerId: ctx.runnerId });
        return "   "; // whitespace-only — must trigger the fallback
      },
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
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    const finalTick = await h.loop.tick();
    expect(finalTick).toBe(false);
    // The custom builder was consulted …
    expect(calls).toHaveLength(1);
    expect(calls[0].runnerId).toBe("runner-1");
    // … but the loop fell back to the default body so the API call
    // never sees an empty `content` field.
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].taskId).toBe(TASK_TEMPLATE.id);
    expect(h.comments[0].body.trim().length).toBeGreaterThan(0);
    expect(h.comments[0].body).toContain("runner runner-1: task failed");
    expect(h.comments[0].body).toContain("exit code: 1");
    expect(h.comments[0].body).toContain("reason: exit");
  });

  it("uses the custom builder's body when it returns non-empty content (s-1164)", async () => {
    const h = makeHarness({
      buildFailureComment: (_task, _result, ctx) =>
        `custom failure marker from ${ctx.runnerId}`,
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
      stderr: "boom",
      stdout: "",
      reason: "exit",
    });
    more = await h.loop.tick();
    expect(more).toBe(true);
    h.loop.requestShutdown();
    await h.loop.tick();
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].body).toBe("custom failure marker from runner-1");
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
      stdout: "",
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

  it("aborts the configured signal on requestShutdown so collaborators (e.g. board watcher) can tear down", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      scripts: [NOOP_SCRIPTED],
      signal: controller.signal,
      abortController: controller,
    });
    expect(controller.signal.aborted).toBe(false);
    h.loop.requestShutdown();
    expect(controller.signal.aborted).toBe(true);
    // Calling requestShutdown again is idempotent — the loop
    // keeps its own shutdown flag, and the abort listener only
    // fires once because { once: true } is set when the loop
    // subscribes in its constructor.
    h.loop.requestShutdown();
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts the signal even when shutdown was driven by --once completion, not by an external signal", async () => {
    // Reproduces the s-1160 regression: --once mode completes a
    // task and calls requestShutdown() internally; without the
    // abort, the board watcher's WS reconnect timer would keep
    // the Node event loop alive and the CLI would never exit.
    const controller = new AbortController();
    const h = makeHarness({
      signal: controller.signal,
      abortController: controller,
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
    // Claim + spawn.
    await h.loop.tick();
    // Resolve the child and let the loop finish the task.
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    await h.loop.tick();
    expect(h.loop.state.processed).toBe(1);
    // driveLoop calls requestShutdown() the moment processed
    // reaches 1 in --once mode; that is the path the watcher
    // teardown relies on. Verify the cascade so any future
    // refactor that moves the requestShutdown() call doesn't
    // silently re-introduce the WS-reconnect-leak bug.
    h.loop.requestShutdown();
    expect(controller.signal.aborted).toBe(true);
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
      stdout: "",
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
      stdout: "",
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

// s-1130 — the WS subscription shaves the worst-case
// `pollIntervalMs` latency off the idle path. The loop has to
// honour `wake()` so the next tick re-attempts a claim
// immediately instead of sleeping through the new task.
describe("RunLoop — wake() short-circuits the idle sleep", () => {
  it("claims on the next tick after wake() even if a script had no eligible task yet", async () => {
    // Two-script harness: first attempt sees nothing, second
    // attempt (triggered by wake) finds a task. We prove the
    // wake triggered the second attempt by counting transport
    // calls — without wake, the harness's noopSleep would
    // never resolve and the second attempt wouldn't happen
    // within the test's lifecycle.
    let attempts = 0;
    const config = makeConfig({ pollIntervalMs: 10_000 });
    const transport = makeClaimTransport([
      {
        request: {
          boardId: "sys",
          status: "todo",
          agentType: "opencoder",
          runnerId: "runner-1",
        },
        outcome: { status: 204, body: null },
      },
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
    ]);
    // Count the actual claim POSTs so the assertion does not
    // depend on the script table length.
    const realPostJson = transport.transport.postJson.bind(transport.transport);
    transport.transport.postJson = async (path, body, init) => {
      if (path === "/runs/claim") attempts += 1;
      return realPostJson(path, body, init);
    };

    const claimClient = new RunClaimClient(transport.transport);
    const heartbeat = new HeartbeatScheduler(claimClient, "runner-1", {
      intervalMs: 1_000,
      setIntervalFn: ((cb: () => void) => ({
        unref: () => undefined,
        _cb: cb,
      })) as unknown as (cb: () => void, ms: number) => unknown,
      clearIntervalFn: () => undefined,
      nowFn: () => 1_000_000,
    });
    const spawner = makeFakeSpawner();
    const commentPoster: FailureCommentPoster = {
      async postComment() {
        return;
      },
    };

    const loop = new RunLoop({
      config,
      runnerId: "runner-1",
      agentType: "opencoder",
      claimClient,
      spawner,
      heartbeat,
      hydrator: makeHydrator(),
      commentPoster,
      sleepFn: async (ms) => {
        // Real sleep so the wake() interrupt can land. We
        // keep this short enough that the test finishes in
        // tens of ms even if wake is never called.
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    // Tick 1 — first claim (returns 204). Loop enters the
    // sleep that would normally last 10s.
    const stillRunning = await loop.tick();
    expect(stillRunning).toBe(true);
    expect(attempts).toBe(1);

    // Kick the wake — the WS subscription would do this when
    // a task_notification arrives. Wait briefly for the
    // interrupt to propagate, then tick again. The second
    // tick should immediately re-attempt a claim and pick
    // up the script's second response.
    loop.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stillRunningAfterWake = await loop.tick();
    expect(stillRunningAfterWake).toBe(true);
    expect(attempts).toBe(2);
    expect(spawner.calls).toHaveLength(1);

    // Cleanup so the test exits cleanly.
    spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    loop.requestShutdown();
    await loop.tick();
  });
});

describe("RunLoop — debug logging", () => {
  it("emits debug traces for start config, claim attempts, hydration, spawn, and result", async () => {
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
      scripts: [claimTask("s-debug-1")],
    });
    // Use run() so the start-of-loop debug line (`loop config:`) fires;
    // tick() short-circuits that branch.
    const runPromise = h.loop.run();
    // Give the run loop a chance to claim + spawn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Drain the agent to trigger the result handler.
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    // Allow the loop to observe the result + finish + post-release.
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    h.loop.requestShutdown();
    await runPromise;

    const debugLogs = h.logs.filter((l) => l.level === "debug");
    const joined = debugLogs.map((l) => l.message).join("\n");
    expect(joined).toMatch(/loop config:/);
    expect(joined).toMatch(/claim attempt:/);
    expect(joined).toMatch(/claim succeeded: taskId=s-debug-1/);
    expect(joined).toMatch(/hydrated task s-debug-1:/);
    expect(joined).toMatch(/spawning agent for task s-debug-1:/);
    expect(joined).toMatch(/agent spawned for task s-debug-1 pid=/);
    expect(joined).toMatch(/agent finished for task s-debug-1:/);
  });

  it("emits debug trace for idle claim (no task)", async () => {
    const h = makeHarness({
      scripts: [
        {
          request: {
            boardId: "sys",
            status: "todo",
            agentType: "opencoder",
            runnerId: "runner-1",
          },
          outcome: { status: 204 },
        },
      ],
    });
    const runPromise = h.loop.run();
    // Allow the first claim to fire and the loop to enter idle sleep.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.loop.requestShutdown();
    await runPromise;

    const debugLogs = h.logs.filter((l) => l.level === "debug");
    const joined = debugLogs.map((l) => l.message).join("\n");
    expect(joined).toMatch(/claim returned 204\/no-content \(idle\)/);
    expect(joined).toMatch(/no task claimed; sleeping \d+ms|undefinedms/);
  });

  it("emits debug trace for claim errors including backoff", async () => {
    // Use a transport that throws to simulate a retryable HTTP error.
    const transport: RunTransport = {
      async postJson<T>(): Promise<{ status: number; body: T | null }> {
        const err = new Error("boom") as Error & { retryable: boolean };
        err.retryable = true;
        throw err;
      },
    };
    const claimClient = new RunClaimClient(transport);
    const heartbeat = new HeartbeatScheduler(claimClient, "runner-1", {
      intervalMs: 1_000,
      setIntervalFn: ((cb) => ({ unref: () => undefined, _cb: cb })) as unknown as (
        cb: () => void,
        ms: number
      ) => unknown,
      clearIntervalFn: () => undefined,
      nowFn: () => 1_000_000,
    });
    const { logger, logs } = makeLogger();
    const config = makeConfig({
      runner: { pollIntervalMs: 100, heartbeatIntervalMs: 1_000 },
    });
    const loop = new RunLoop({
      config,
      runnerId: "runner-1",
      agentType: "opencoder",
      claimClient,
      spawner: makeFakeSpawner(),
      heartbeat,
      hydrator: makeHydrator(),
      commentPoster: { async postComment() { return; } },
      sleepFn: async () => undefined,
      logger,
    });
    await loop.tick();
    loop.requestShutdown();
    await loop.tick();

    const debugLogs = logs.filter((l) => l.level === "debug");
    const joined = debugLogs.map((l) => l.message).join("\n");
    expect(joined).toMatch(/claim attempt:/);
    expect(joined).toMatch(/backing off \d+ms before next claim/);
    const errorLogs = logs.filter((l) => l.level === "error");
    expect(errorLogs.map((l) => l.message).join("\n")).toMatch(
      /claim failed:.*boom \(retryable=true\)/
    );
  });

  it("emits a debug trace when wake() is called", async () => {
    const h = makeHarness({ scripts: [] });
    h.loop.wake();
    expect(h.logs.some((l) => l.level === "debug" && l.message.includes("wake() called"))).toBe(true);
  });
});

// s-1187: per-task variable substitution in `agent.args`. The loop
// passes the hydrated task / board / column context as a
// `variables` map to `AgentSpawner.spawn`; the spawn layer
// substitutes every supported `$name` token in `cfg.args` before
// the child process is launched. The harness's fake
// `ProcessSpawner` captures the post-substitution `SpawnOptions`,
// so we assert on what the agent actually saw in argv.
describe("RunLoop — $name variable substitution in agent.args (s-1187)", () => {
  function claimScriptFor(task: TaskRecord): ScriptedClaim {
    return {
      request: {
        boardId: "sys",
        status: "todo",
        agentType: "opencoder",
        runnerId: "runner-1",
      },
      outcome: {
        status: 200,
        body: { task, run: { taskId: task.id, runnerId: "runner-1" } },
      },
    };
  }

  function hydratorFor(task: TaskRecord): TaskHydrator {
    return {
      fetchComments: async () => [],
      fetchSubtasks: async () => [],
      fetchBoard: async () => ({ id: "sys", name: "Sys" }),
      fetchColumn: async () => ({
        id: task.columnId ?? "col-1",
        name: "进行中",
      }),
      fetchTask: async () => task,
    };
  }

  it("expands $taskId / $title / $body / $priority / $assignee in argv", async () => {
    const task: TaskRecord = {
      ...TASK_TEMPLATE,
      id: "s-1187",
      title: "wire up $name substitution",
      description: "free-form body for the agent",
      priority: "high",
      assignee: "alice",
      columnId: "col-1",
    };
    const h = makeHarness({
      config: makeConfig({
        agent: {
          args: [
            "--task=$taskId",
            "--title=$title",
            "--body=$body",
            "--priority=$priority",
            "--assignee=$assignee",
            "--column=$columnId",
            "--board=$boardId",
          ],
        },
      }),
      hydrator: hydratorFor(task),
      scripts: [claimScriptFor(task)],
    });
    await h.loop.tick();

    const call = h.spawner.calls[0];
    expect(call).toBeDefined();
    // The user-supplied args (with $name substituted) come first; the
    // `--prompt <path>` pair appends after the default `promptPosition`.
    expect(call.args.slice(0, 7)).toEqual([
      "--task=s-1187",
      "--title=wire up $name substitution",
      "--body=free-form body for the agent",
      "--priority=high",
      "--assignee=alice",
      "--column=col-1",
      "--board=sys",
    ]);
    expect(call.args).toContain("--prompt");
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    h.loop.requestShutdown();
    await h.loop.tick();
  });

  it("renders empty string for missing fields so argv shape is preserved", async () => {
    const task: TaskRecord = {
      ...TASK_TEMPLATE,
      id: "s-1187-empty",
      // No title, no description, no assignee.
      title: undefined,
      description: undefined,
      priority: undefined,
      assignee: undefined,
      columnId: "col-2",
    };
    const h = makeHarness({
      config: makeConfig({
        agent: {
          args: [
            "--task=$taskId",
            "--title=$title",
            "--body=$body",
            "--assignee=$assignee",
          ],
        },
      }),
      hydrator: hydratorFor(task),
      scripts: [claimScriptFor(task)],
    });
    await h.loop.tick();

    const call = h.spawner.calls[0];
    expect(call).toBeDefined();
    // Indices must not shift — operator layout survives the missing
    // fields. The four user flags are at the front; the prompt pair
    // appends after them.
    expect(call.args.slice(0, 4)).toEqual([
      "--task=s-1187-empty",
      "--title=",
      "--body=",
      "--assignee=",
    ]);
    h.spawner.resolveIndex(0, {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      reason: "exit",
    });
    h.loop.requestShutdown();
    await h.loop.tick();
  });
});
