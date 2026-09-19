// Tests for `cli/src/runner/claim.ts` — the HTTP client wrapping the
// `/api/v1/runs/*` endpoints. The tests inject a `RunTransport` so we
// never touch the real `HttpClient`, then assert:
//
//   * `claim`     — 200 wraps to `{ kind: "claimed" }`, 204 wraps to
//                   `{ kind: "none" }`, 409 throws with
//                   `retryable=false`.
//   * `heartbeat` — 200 wraps to `{ kind: "ok", expiresAt }`, 409 wraps
//                   to `{ kind: "lost" }`.
//   * `finish`    — 200 wraps to `{ kind: "ok", advanced }`, 409 wraps
//                   to `{ kind: "conflict" }`.
//   * `release`   — 200 returns the released count, 5xx throws.
//
// We also exercise `RunnerHttpError` retryable classification and
// the `HttpRunTransport` JSON parsing layer (malformed body → throw).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClaimRequest,
  HttpRunTransport,
  type RunTransport,
  RunClaimClient,
  RunnerHttpError,
} from "../../src/runner/claim.js";

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

function makeTransport(scripts: ScriptedResponse[]): {
  transport: RunTransport;
  calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  let i = 0;
  const transport: RunTransport = {
    async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
      calls.push({ path, body });
      const r = scripts[Math.min(i, scripts.length - 1)];
      i++;
      return { status: r.status, body: (r.body ?? null) as T };
    },
  };
  return { transport, calls };
}

const BASE_REQUEST: ClaimRequest = {
  boardId: "sys",
  status: "todo",
  agentType: "opencoder",
  runnerId: "runner-1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunClaimClient.claim", () => {
  it("returns { kind: 'none' } on a 204 response", async () => {
    const { transport, calls } = makeTransport([{ status: 204 }]);
    const client = new RunClaimClient(transport);
    const outcome = await client.claim(BASE_REQUEST);
    expect(outcome.kind).toBe("none");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/runs/claim");
    expect(calls[0].body).toMatchObject({
      boardId: "sys",
      status: "todo",
      agentType: "opencoder",
      runnerId: "runner-1",
    });
  });

  it("returns { kind: 'claimed' } with task + run on a 200 response", async () => {
    const task = {
      id: "s-1090",
      title: "Implement runner loop",
      agentPrompt: "follow the algorithm",
      columnId: "col-1",
    };
    const run = {
      taskId: "s-1090",
      runnerId: "runner-1",
      status: "claimed",
      expiresAt: "2030-01-01T00:00:00Z",
    };
    const { transport } = makeTransport([
      { status: 200, body: { task, run } },
    ]);
    const client = new RunClaimClient(transport);
    const outcome = await client.claim(BASE_REQUEST);
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind === "claimed") {
      expect(outcome.task).toEqual(task);
      expect(outcome.run).toEqual(run);
    }
  });

  it("throws a non-retryable RunnerHttpError on a 409 response", async () => {
    const { transport } = makeTransport([
      { status: 409, body: { error: "permission denied" } },
    ]);
    const client = new RunClaimClient(transport);
    await expect(client.claim(BASE_REQUEST)).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: false,
      status: 409,
      path: "/runs/claim",
    });
  });

  it("throws a retryable RunnerHttpError on a 500 response", async () => {
    const { transport } = makeTransport([{ status: 500 }]);
    const client = new RunClaimClient(transport);
    await expect(client.claim(BASE_REQUEST)).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: true,
      status: 500,
    });
  });

  it("propagates the mode flag through to the request body", async () => {
    const { transport, calls } = makeTransport([{ status: 204 }]);
    const client = new RunClaimClient(transport);
    await client.claim({ ...BASE_REQUEST, mode: "mine" });
    expect(calls[0].body).toMatchObject({ mode: "mine" });
  });
});

describe("RunClaimClient.heartbeat", () => {
  it("returns { kind: 'ok', expiresAt } on 200", async () => {
    const { transport, calls } = makeTransport([
      { status: 200, body: { expiresAt: "2030-01-01T00:00:00Z" } },
    ]);
    const client = new RunClaimClient(transport);
    const outcome = await client.heartbeat("s-1090", "runner-1");
    expect(outcome).toEqual({
      kind: "ok",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(calls[0].path).toBe("/runs/s-1090/heartbeat");
    expect(calls[0].body).toEqual({ runnerId: "runner-1" });
  });

  it("returns { kind: 'lost' } on 409", async () => {
    const { transport } = makeTransport([
      { status: 409, body: { error: "lock expired" } },
    ]);
    const client = new RunClaimClient(transport);
    const outcome = await client.heartbeat("s-1090", "runner-1");
    expect(outcome.kind).toBe("lost");
  });
});

describe("RunClaimClient.finish", () => {
  it("returns { kind: 'ok', advanced } on 200", async () => {
    const { transport, calls } = makeTransport([
      { status: 200, body: { success: true, advanced: true } },
    ]);
    const client = new RunClaimClient(transport);
    const outcome = await client.finish("s-1090", {
      runnerId: "runner-1",
      status: "completed",
      exitCode: 0,
      error: null,
    });
    expect(outcome).toEqual({ kind: "ok", advanced: true });
    expect(calls[0].path).toBe("/runs/s-1090/finish");
    expect(calls[0].body).toEqual({
      runnerId: "runner-1",
      status: "completed",
      exitCode: 0,
      error: null,
      output: null,
    });
  });

  it("returns { kind: 'conflict' } on 409", async () => {
    const { transport } = makeTransport([{ status: 409 }]);
    const client = new RunClaimClient(transport);
    const outcome = await client.finish("s-1090", {
      runnerId: "runner-1",
      status: "failed",
    });
    expect(outcome.kind).toBe("conflict");
  });
});

describe("RunClaimClient.release", () => {
  it("returns the released count on 200", async () => {
    const { transport, calls } = makeTransport([
      { status: 200, body: { released: 3 } },
    ]);
    const client = new RunClaimClient(transport);
    const outcome = await client.release({ runnerId: "runner-1" });
    expect(outcome).toEqual({ kind: "ok", released: 3 });
    expect(calls[0].path).toBe("/runs/release");
  });

  it("throws a retryable error on a 5xx response", async () => {
    const { transport } = makeTransport([{ status: 503 }]);
    const client = new RunClaimClient(transport);
    await expect(
      client.release({ runnerId: "runner-1" })
    ).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: true,
      status: 503,
    });
  });
});

describe("HttpRunTransport — JSON parsing", () => {
  function makeHttp(scripts: ScriptedResponse[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    let i = 0;
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = scripts[Math.min(i, scripts.length - 1)];
      i++;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // Response constructor rejects non-null bodies for status 204/304;
      // honour the spec by passing `null` when the script has no body.
      const body =
        r.body === undefined || r.status === 204 || r.status === 304
          ? null
          : JSON.stringify(r.body);
      return new Response(body, { status: r.status, headers });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(spy as typeof fetch);
    return { calls, spy };
  }

  function makeClient() {
    // Minimal HttpClient-shaped object: only `apiUrl` and `bearerToken`
    // are touched by `HttpRunTransport`. We deliberately omit `fetchImpl`
    // so the transport picks up the (mocked) globalThis.fetch at call time.
    return {
      apiUrl: "http://localhost:8080",
      bearerToken: async () => null,
    };
  }

  it("prepends /api/v1 when the path is missing the prefix", async () => {
    const { calls } = makeHttp([{ status: 204 }]);
    const transport = new HttpRunTransport(makeClient() as never);
    const out = await transport.postJson("/runs/claim", { x: 1 });
    expect(out.status).toBe(204);
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/runs/claim");
  });

  it("does not double-prefix when /api/v1 is already present", async () => {
    const { calls } = makeHttp([{ status: 200, body: { ok: true } }]);
    const transport = new HttpRunTransport(makeClient() as never);
    await transport.postJson("/api/v1/runs/release", {});
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/runs/release");
  });

  it("attaches the bearer token when supplied", async () => {
    const { calls } = makeHttp([{ status: 200, body: {} }]);
    const client = {
      apiUrl: "http://localhost:8080",
      bearerToken: async () => "tok-1",
    };
    const transport = new HttpRunTransport(client as never);
    await transport.postJson("/runs/release", {});
    const init = calls[0].init as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-1"
    );
  });

  it("throws RunnerHttpError on a malformed JSON body", async () => {
    makeHttp([]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as unknown as Response
    );
    const transport = new HttpRunTransport(makeClient() as never);
    await expect(
      transport.postJson("/runs/claim", {})
    ).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: false,
    });
  });

  it("wraps fetch rejections into a retryable RunnerHttpError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const transport = new HttpRunTransport(makeClient() as never);
    await expect(
      transport.postJson("/runs/claim", {})
    ).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: true,
    });
  });
});

describe("RunClaimClient.fromHttpClient", () => {
  it("wraps the supplied HttpClient in an HttpRunTransport", async () => {
    const postJsonSpy = vi.spyOn(HttpRunTransport.prototype, "postJson");
    postJsonSpy.mockResolvedValueOnce({ status: 204, body: null });
    const fakeClient = {
      apiUrl: "http://localhost:8080",
      bearerToken: async () => null,
    };
    const client = RunClaimClient.fromHttpClient(fakeClient as never);
    const outcome = await client.claim(BASE_REQUEST);
    expect(outcome.kind).toBe("none");
  });
});

describe("RunnerHttpError", () => {
  it("defaults retryable to true and status to 0", () => {
    const err = new RunnerHttpError("boom");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
    expect(err.path).toBe("");
    expect(err.name).toBe("RunnerHttpError");
  });

  it("accepts explicit options", () => {
    const cause = new Error("inner");
    const err = new RunnerHttpError("boom", {
      retryable: false,
      status: 404,
      path: "/x",
      cause,
    });
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(404);
    expect(err.path).toBe("/x");
    expect(err.cause).toBe(cause);
  });
});

// s-1229: the runner used to surface a 401 from any /runs/* endpoint
// as an opaque "API error 401" and shut down — even though the user
// had a perfectly good refresh token on disk. These tests pin the
// retry-on-401 behaviour the RunClaimClient now provides.
describe("RunClaimClient — refresh on 401", () => {
  it("retries once with a refreshed token on a 401 claim", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      {
        status: 200,
        body: {
          task: { id: "s-1229" },
          run: { taskId: "s-1229", runnerId: "runner-1" },
        },
      },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    const outcome = await client.claim(BASE_REQUEST);
    expect(outcome.kind).toBe("claimed");
    expect(calls).toHaveLength(2);
    expect(refreshCalls.count).toBe(1);
  });

  it("surfaces a clear session-expired error when refresh fails", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return false;
      },
    });
    await expect(client.claim(BASE_REQUEST)).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: false,
      status: 401,
      path: "/runs/claim",
      message: expect.stringMatching(/session expired|auth login/i),
    });
    expect(calls).toHaveLength(1);
    expect(refreshCalls.count).toBe(1);
  });

  it("surfaces a clear session-expired error when refresh succeeds but retry still 401s", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      { status: 401, body: { error: "still expired" } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    await expect(client.claim(BASE_REQUEST)).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: false,
      status: 401,
      message: expect.stringMatching(/session expired|auth login/i),
    });
    expect(calls).toHaveLength(2);
    expect(refreshCalls.count).toBe(1);
  });

  it("retries once on heartbeat 401", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { expiresAt: "2030-01-01T00:00:00Z" } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    const outcome = await client.heartbeat("s-1229", "runner-1");
    expect(outcome).toEqual({ kind: "ok", expiresAt: "2030-01-01T00:00:00Z" });
    expect(calls).toHaveLength(2);
    expect(refreshCalls.count).toBe(1);
  });

  it("retries once on finish 401", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { advanced: true } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    const outcome = await client.finish("s-1229", {
      runnerId: "runner-1",
      status: "completed",
    });
    expect(outcome).toEqual({ kind: "ok", advanced: true });
    expect(calls).toHaveLength(2);
    expect(refreshCalls.count).toBe(1);
  });

  it("retries once on release 401", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { released: 2 } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    const outcome = await client.release({ runnerId: "runner-1" });
    expect(outcome).toEqual({ kind: "ok", released: 2 });
    expect(calls).toHaveLength(2);
    expect(refreshCalls.count).toBe(1);
  });

  it("treats a refresh hook that throws as a failed refresh", async () => {
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        throw new Error("token endpoint unreachable");
      },
    });
    await expect(client.claim(BASE_REQUEST)).rejects.toMatchObject({
      name: "RunnerHttpError",
      retryable: false,
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it("does not call refresh when the first response is 200", async () => {
    const refreshCalls = { count: 0 };
    const { transport } = makeTransport([
      { status: 204, body: null },
    ]);
    const client = new RunClaimClient(transport, {
      refreshAuth: async () => {
        refreshCalls.count += 1;
        return true;
      },
    });
    await client.claim(BASE_REQUEST);
    expect(refreshCalls.count).toBe(0);
  });

  it("allows swapping the refresh hook via setRefreshAuth", async () => {
    const refreshCalls = { count: 0 };
    const { transport, calls } = makeTransport([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = new RunClaimClient(transport);
    expect(calls).toHaveLength(0);
    client.setRefreshAuth(async () => {
      refreshCalls.count += 1;
      return true;
    });
    await client.release({ runnerId: "runner-1" });
    expect(refreshCalls.count).toBe(1);
    expect(calls).toHaveLength(2);
  });
});
