// Tests for `kanban attach <taskId>`.
//
// The command posts to POST /api/v1/runs/:taskId/attach and
// prints a one-row confirmation table. We mock fetch (the same
// pattern runs.test.ts uses) so we can assert:
//   * the URL path is built correctly
//   * the request body carries runnerId + agentType
//   * the rendered table surfaces the taskId / title /
//     runnerId / status so an operator can copy/paste the
//     runnerId into a follow-up heartbeat / finish curl
//   * validation paths: empty taskId, negative lockTimeoutMs,
//     404 / 409 / 422 error mapping
//   * NotLoggedInError for 401/403 so the CLI exits with the
//     documented auth code

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient } from "../http/client.js";
import { runAttach } from "./attach.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

function scriptFetch(responses: ScriptedResponse[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(
      r.body === undefined ? "" : JSON.stringify(r.body),
      {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }
    );
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return { calls, spy };
}

function makeCapture() {
  let stdout = "";
  let stderr = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    },
  });
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    },
  });
  return {
    io: {
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
    },
    read: () => ({ stdout, stderr }),
  };
}

const ATTACH_PAYLOAD = {
  task: {
    id: "task-1",
    title: "Investigate flaky test",
    priority: "high",
    columnId: "col-1",
    columnName: "Todo",
    position: 1000,
    published: true,
    archived: false,
    archivedAt: null,
    createdBy: "u-admin",
    createdAt: "2026-09-13T10:00:00Z",
    updatedAt: "2026-09-13T10:00:00Z",
    description: null,
    assignee: null,
    meta: null,
    _count: { comments: 0, subtasks: 0 },
  },
  run: {
    taskId: "task-1",
    runnerId: "runner-A",
    agentId: "opencoder",
    boardId: "board-1",
    columnId: "col-1",
    status: "claimed",
    claimedAt: "2026-09-13T10:00:00Z",
    lastHeartbeatAt: "2026-09-13T10:00:00Z",
    expiresAt: "2026-09-13T10:02:00Z",
    finishedAt: null,
    exitCode: null,
    error: null,
  },
};

describe("runAttach", () => {
  beforeEach(() => {
    process.env.KANBAN_RUNNER_AGENT_TYPE = "opencoder";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KANBAN_RUNNER_AGENT_TYPE;
  });

  it("posts to the attach endpoint with a generated runnerId", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ATTACH_PAYLOAD }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    const report = await runAttach({
      apiUrl: "https://api.example.com/",
      taskId: "task-1",
      io: capture.io,
      http,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.example.com/api/v1/runs/task-1/attach"
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body.agentType).toBe("opencoder");
    expect(typeof body.runnerId).toBe("string");
    expect(body.runnerId.length).toBeGreaterThan(0);
    // runnerId is auto-generated when the caller doesn't
    // supply one, so the report echoes back the generated
    // value rather than the canonical response runnerId.
    expect(report.task.id).toBe("task-1");
    expect(report.run.status).toBe("claimed");
    const { stdout } = capture.read();
    expect(stdout).toContain("Attach");
    expect(stdout).toContain("task-1");
    expect(stdout).toContain("claimed");
  });

  it("respects an explicit runnerId and reason", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ATTACH_PAYLOAD }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await runAttach({
      apiUrl: "https://api.example.com",
      taskId: "task-2",
      runnerId: "runner-explicit",
      reason: "manual escalation",
      io: capture.io,
      http,
    });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body.runnerId).toBe("runner-explicit");
    expect(body.reason).toBe("manual escalation");
  });

  it("includes lockTimeoutMs when supplied", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ATTACH_PAYLOAD }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await runAttach({
      apiUrl: "https://api.example.com",
      taskId: "task-3",
      runnerId: "runner-A",
      lockTimeoutMs: 90000,
      io: capture.io,
      http,
    });

    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body.lockTimeoutMs).toBe(90000);
  });

  it("encodes taskId with special characters", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ATTACH_PAYLOAD }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await runAttach({
      apiUrl: "https://api.example.com",
      taskId: "task/with spaces",
      runnerId: "runner-A",
      io: capture.io,
      http,
    });

    expect(calls[0].url).toBe(
      "https://api.example.com/api/v1/runs/task%2Fwith%20spaces/attach"
    );
  });

  it("throws InvalidUsageError when taskId is missing", async () => {
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "  ",
        io: capture.io,
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError on negative lockTimeoutMs", async () => {
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        lockTimeoutMs: -1,
        io: capture.io,
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = capture.read();
    expect(stderr).toContain("kanban auth login");
  });

  it("maps 403 to NotLoggedInError", async () => {
    scriptFetch([{ status: 403, body: { error: "forbidden" } }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("maps 404 to InvalidUsageError with the server message", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-missing",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toMatchObject({
      name: "InvalidUsageError",
      message: expect.stringContaining("Task not found"),
    });
  });

  it("maps 409 lock contention to InvalidUsageError", async () => {
    scriptFetch([
      {
        status: 409,
        body: { error: "Task is already locked by another runner" },
      },
    ]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toMatchObject({
      name: "InvalidUsageError",
      message: expect.stringContaining("already locked"),
    });
  });

  it("maps 422 to InvalidUsageError", async () => {
    scriptFetch([{ status: 422, body: { error: "Task is archived" } }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toMatchObject({
      name: "InvalidUsageError",
      message: expect.stringContaining("archived"),
    });
  });

  it("throws InvalidUsageError when the response shape is wrong", async () => {
    scriptFetch([{ status: 200, body: { task: null, run: null } }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await expect(
      runAttach({
        apiUrl: "https://api.example.com",
        taskId: "task-1",
        runnerId: "runner-A",
        io: capture.io,
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("emits JSON when format=json is requested", async () => {
    scriptFetch([{ status: 200, body: ATTACH_PAYLOAD }]);
    const capture = makeCapture();
    const http = new HttpClient({ apiUrl: "https://api.example.com" });

    await runAttach({
      apiUrl: "https://api.example.com",
      taskId: "task-1",
      runnerId: "runner-A",
      format: "json",
      io: capture.io,
      http,
    });
    const { stdout } = capture.read();
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout);
    expect(parsed.taskId).toBe("task-1");
    expect(parsed.task.id).toBe("task-1");
  });
});
