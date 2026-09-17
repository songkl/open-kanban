// Tests for `kanban subtasks list / create / update / delete`.
//
// HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover the request shape (URL, method, body, query), the
// JSON output shape, and the tabular rendering. The subtasks endpoints
// are auth-gated (RequireAuth in backend/cmd/server/main.go) but the
// CLI code defers to the HttpClient for bearer-token plumbing, so the
// mocked fetch simply needs to surface the right URL / body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runSubtasksList,
  runSubtasksCreate,
  runSubtasksUpdate,
  runSubtasksDelete,
} from "./subtasks.js";
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
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
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

const SUBTASK_PAYLOAD = {
  id: "st1",
  title: "Write spec",
  completed: false,
  taskId: "t1",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T03:04:05Z",
};

const SUBTASKS_LIST_PAYLOAD = [
  {
    id: "st1",
    title: "Write spec",
    completed: true,
    taskId: "t1",
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T03:04:05Z",
  },
  {
    id: "st2",
    title: "Implement feature",
    completed: false,
    taskId: "t1",
    createdAt: "2026-01-03T03:04:05Z",
    updatedAt: "2026-01-03T03:04:05Z",
  },
];

const UPDATED_SUBTASK_PAYLOAD = {
  id: "st1",
  title: "Write spec (v2)",
  completed: true,
  taskId: "t1",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-04T03:04:05Z",
};

const DELETE_SUCCESS_PAYLOAD = { success: true };

describe("runSubtasksList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/subtasks?taskId=<id>", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: SUBTASKS_LIST_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runSubtasksList(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/subtasks");
    expect(url.searchParams.get("taskId")).toBe("t1");
    expect(report.subtasks).toHaveLength(2);
    expect(report.taskId).toBe("t1");
    expect(report.apiUrl).toBe("http://kanban.example.com");
  });

  it("encodes task ids with special characters in the query string", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksList(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("taskId")).toBe("a/b c");
  });

  it("renders id / title / completed / taskId / createdAt by default", async () => {
    scriptFetch([{ status: 200, body: SUBTASKS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runSubtasksList(
      {
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Subtasks");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("task=t1");
    expect(stdout).toContain("st1");
    expect(stdout).toContain("st2");
    expect(stdout).toContain("Write spec");
    expect(stdout).toContain("Implement feature");
    expect(stdout).toContain("2026-01-02T03:04:05Z");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: SUBTASKS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runSubtasksList(
      {
        apiUrl: "http://kanban.example.com",
        http,
        format: "json",
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.taskId).toBe("t1");
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.subtasks[0].id).toBe("st1");
    expect(parsed.subtasks[1].id).toBe("st2");
    expect(report.subtasks).toHaveLength(2);
  });

  it("handles an empty subtasks list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runSubtasksList(
      {
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      },
      "t1"
    );
    expect(report.subtasks).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no subtasks");
  });

  it("coerces a non-array payload into an empty list", async () => {
    scriptFetch([{ status: 200, body: { not: "a list" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runSubtasksList(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(report.subtasks).toEqual([]);
  });

  it("throws InvalidUsageError when task id is missing or whitespace", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksList({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runSubtasksList({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps AuthError to NotLoggedInError with a stderr hint", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runSubtasksList(
        {
          apiUrl: "http://kanban.example.com",
          http,
          io: cap.io,
        },
        "t1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/not logged in/i);
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runSubtasksList(
        {
          apiUrl: "http://kanban.example.com",
          http,
          io: cap.io,
        },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/task not found/i);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksList({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runSubtasksCreate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { taskId, title } to /api/v1/subtasks", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runSubtasksCreate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec",
        http,
      },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/subtasks");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ taskId: "t1", title: "Write spec" });
    expect(result.subtask.id).toBe("st1");
    expect(result.subtask.title).toBe("Write spec");
  });

  it("trims whitespace from --title before sending", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksCreate(
      {
        apiUrl: "http://kanban.example.com",
        title: "  Padded title  ",
        http,
      },
      "t1"
    );
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body.title).toBe("Padded title");
  });

  it("rejects an empty --title with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksCreate(
        { apiUrl: "http://kanban.example.com", title: "   ", http },
        "t1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError when task id is missing", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksCreate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        ""
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runSubtasksCreate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("prints a confirmation to stdout in table mode", async () => {
    scriptFetch([{ status: 200, body: SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runSubtasksCreate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toMatch(/created subtask/i);
    expect(stdout).toContain("st1");
    expect(stdout).toContain("t1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runSubtasksCreate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec",
        format: "json",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.subtask.id).toBe("st1");
    expect(parsed.subtask.title).toBe("Write spec");
    expect(result.apiUrl).toBe("http://kanban.example.com");
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runSubtasksCreate(
        {
          apiUrl: "http://kanban.example.com",
          title: "Write spec",
          http,
          io: cap.io,
        },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/task not found/i);
  });

  it("maps AuthError to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksCreate(
        { apiUrl: "http://kanban.example.com", title: "Write spec", http },
        "t1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksCreate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        "t1"
      )
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runSubtasksUpdate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs { completed: true } to /api/v1/subtasks/:id when --completed is set", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        completed: true,
        http,
      },
      "st1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/subtasks/st1");
    expect(calls[0].init?.method).toBe("PUT");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ completed: true });
    expect(result.subtask.id).toBe("st1");
    expect(result.subtask.completed).toBe(true);
  });

  it("PUTs { title } to /api/v1/subtasks/:id when only --title is set", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec (v2)",
        http,
      },
      "st1"
    );
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ title: "Write spec (v2)" });
  });

  it("PUTs both title and completed when both are set", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec (v2)",
        completed: false,
        http,
      },
      "st1"
    );
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ title: "Write spec (v2)", completed: false });
  });

  it("PUTs { completed: false } when --no-completed is used", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        completed: false,
        http,
      },
      "st1"
    );
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body.completed).toBe(false);
  });

  it("trims whitespace from --title", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "  Trim me  ",
        http,
      },
      "st1"
    );
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body.title).toBe("Trim me");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UPDATED_SUBTASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "x",
        http,
      },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/subtasks/a%2Fb%20c"
    );
  });

  it("throws InvalidUsageError when no fields are provided", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", http },
        "st1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError when --title is empty or whitespace", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", title: "   ", http },
        "st1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        ""
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("prints an Updated confirmation to stdout", async () => {
    scriptFetch([{ status: 200, body: UPDATED_SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "x",
        http,
        io: cap.io,
      },
      "st1"
    );
    const { stdout } = cap.read();
    expect(stdout).toMatch(/updated subtask/i);
    expect(stdout).toContain("st1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: UPDATED_SUBTASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runSubtasksUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Write spec (v2)",
        format: "json",
        http,
        io: cap.io,
      },
      "st1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.subtask.id).toBe("st1");
    expect(parsed.subtask.title).toBe("Write spec (v2)");
    expect(result.apiUrl).toBe("http://kanban.example.com");
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Subtask not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runSubtasksUpdate(
        {
          apiUrl: "http://kanban.example.com",
          title: "x",
          http,
          io: cap.io,
        },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/subtask not found/i);
  });

  it("maps AuthError to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        "st1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksUpdate(
        { apiUrl: "http://kanban.example.com", title: "x", http },
        "st1"
      )
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runSubtasksDelete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs /api/v1/subtasks/:id", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: DELETE_SUCCESS_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runSubtasksDelete(
      { apiUrl: "http://kanban.example.com", http },
      "st1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/subtasks/st1");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(result.id).toBe("st1");
    expect(result.success).toBe(true);
  });

  it("defaults --yes to true so the call works in pipelines", async () => {
    scriptFetch([{ status: 200, body: DELETE_SUCCESS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksDelete(
      { apiUrl: "http://kanban.example.com", http },
      "st1"
    );
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: DELETE_SUCCESS_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runSubtasksDelete(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/subtasks/a%2Fb%20c"
    );
  });

  it("prints a Deleted confirmation to stdout in table mode", async () => {
    scriptFetch([{ status: 200, body: DELETE_SUCCESS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runSubtasksDelete(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "st1"
    );
    const { stdout } = cap.read();
    expect(stdout).toMatch(/deleted subtask/i);
    expect(stdout).toContain("st1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: DELETE_SUCCESS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runSubtasksDelete(
      {
        apiUrl: "http://kanban.example.com",
        http,
        format: "json",
        io: cap.io,
      },
      "st1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.id).toBe("st1");
    expect(parsed.success).toBe(true);
    expect(result.id).toBe("st1");
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksDelete(
        { apiUrl: "http://kanban.example.com", http },
        ""
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runSubtasksDelete(
        { apiUrl: "http://kanban.example.com", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Subtask not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runSubtasksDelete(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/subtask not found/i);
  });

  it("maps AuthError to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksDelete(
        { apiUrl: "http://kanban.example.com", http },
        "st1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runSubtasksDelete(
        { apiUrl: "http://kanban.example.com", http },
        "st1"
      )
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});
