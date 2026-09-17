// Tests for `cli/src/runner/heartbeat.ts` — interval scheduler driving
// `RunClaimClient.heartbeat`. We use vitest's fake timers so the test
// can drive the scheduler deterministically and assert the exact set
// of round-trips the loop would observe.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatScheduler } from "../../src/runner/heartbeat.js";
import {
  type ClaimRequest,
  type HeartbeatOutcome,
  type RunTransport,
  RunClaimClient,
} from "../../src/runner/claim.js";

function makeTransport(scripts: { status: number; body?: unknown }[]): {
  transport: RunTransport;
  calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  let i = 0;
  return {
    transport: {
      async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
        calls.push({ path, body });
        const r = scripts[Math.min(i, scripts.length - 1)];
        i++;
        return { status: r.status, body: (r.body ?? null) as T };
      },
    },
    calls,
  };
}

const BASE: ClaimRequest = {
  boardId: "sys",
  status: "todo",
  agentType: "opencoder",
  runnerId: "runner-1",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("HeartbeatScheduler — interval behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls heartbeat.tickNow on the configured cadence", async () => {
    const { transport, calls } = makeTransport([
      { status: 200, body: { expiresAt: "2030-01-01T00:00:00Z" } },
      { status: 200, body: { expiresAt: "2030-01-01T00:01:00Z" } },
      { status: 200, body: { expiresAt: "2030-01-01T00:02:00Z" } },
    ]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    expect(scheduler.active).toBe(true);
    expect(scheduler.currentTask).toBe("s-1");
    await vi.advanceTimersByTimeAsync(3_000);
    scheduler.stop();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.map((c) => c.path)).toEqual([
      "/runs/s-1/heartbeat",
      "/runs/s-1/heartbeat",
      "/runs/s-1/heartbeat",
    ]);
    for (const call of calls) {
      expect(call.body).toEqual({ runnerId: "runner-1" });
    }
  });

  it("switches the active task atomically on start()", async () => {
    const { transport } = makeTransport([
      { status: 200, body: { expiresAt: "x" } },
    ]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    scheduler.start("s-1"); // no-op
    scheduler.start("s-2"); // switch
    expect(scheduler.currentTask).toBe("s-2");
    scheduler.stop();
  });

  it("stop() clears the current task and the interval", async () => {
    const { transport, calls } = makeTransport([
      { status: 200, body: { expiresAt: "x" } },
    ]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    scheduler.stop();
    expect(scheduler.active).toBe(false);
    expect(scheduler.currentTask).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
  });

  it("tickNow() resolves with the latest outcome", async () => {
    const { transport } = makeTransport([
      { status: 200, body: { expiresAt: "2030-01-01T00:00:00Z" } },
    ]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    const result = await scheduler.tickNow();
    expect(result.outcome).toEqual({
      kind: "ok",
      expiresAt: "2030-01-01T00:00:00Z",
    });
  });

  it("propagates a 409 as a { kind: 'lost' } outcome", async () => {
    const { transport } = makeTransport([{ status: 409 }]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    const result = await scheduler.tickNow();
    expect(result.outcome.kind).toBe("lost");
  });

  it("invokes listeners on every tick (success + failure)", async () => {
    const { transport } = makeTransport([
      { status: 200, body: { expiresAt: "x" } },
      { status: 500 },
    ]);
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    const events: HeartbeatOutcome[] = [];
    scheduler.onTick((r) => events.push(r.outcome));
    scheduler.start("s-1");
    await scheduler.tickNow();
    await scheduler.tickNow();
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("ok");
    expect(events[1].kind).toBe("lost");
  });

  it("does not re-fire while a previous tick is in flight", async () => {
    let resolveHeartbeat: (() => void) | null = null;
    let calls = 0;
    const transport: RunTransport = {
      async postJson<T>(): Promise<{ status: number; body: T | null }> {
        calls++;
        await new Promise<void>((r) => {
          resolveHeartbeat = r;
        });
        return { status: 200, body: { expiresAt: "x" } as T };
      },
    };
    const client = new RunClaimClient(transport);
    const scheduler = new HeartbeatScheduler(client, "runner-1", {
      intervalMs: 1_000,
    });
    scheduler.start("s-1");
    const first = scheduler.tickNow();
    // The second call should resolve immediately because the first
    // tick is still in-flight; the transport is called exactly once.
    const second = scheduler.tickNow();
    resolveHeartbeat?.();
    await first;
    await second;
    expect(calls).toBe(1);
  });
});

describe("HeartbeatScheduler — construction", () => {
  it("rejects non-positive intervals", () => {
    const client = new RunClaimClient(makeTransport([]).transport);
    expect(() => new HeartbeatScheduler(client, "r", { intervalMs: 0 })).toThrow();
    expect(() => new HeartbeatScheduler(client, "r", { intervalMs: -1 })).toThrow();
  });
});
