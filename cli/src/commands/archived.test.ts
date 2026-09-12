// Tests for `kanban archived list / archive / restore`.
//
// HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover the request shape (URL, method, body), the JSON
// output shape, and the tabular rendering. The archived endpoints are
// auth-gated (RequireAuth in backend/cmd/server/main.go) but the CLI
// code defers to the HttpClient for bearer-token plumbing, so the
// mocked fetch simply needs to surface the right URL / body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runArchivedList,
  runArchivedArchive,
  runArchivedRestore,
} from "./archived.js";
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

const ARCHIVED_PAYLOAD = [
  {
    id: "a1",
    title: "Archived one",
    priority: "low",
    assignee: "bob",
    archived: true,
    archivedAt: "2026-01-05T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "a2",
    title: "Archived two",
    priority: "medium",
    assignee: null,
    archived: true,
    archivedAt: "2026-01-04T00:00:00Z",
    createdAt: "2025-12-30T00:00:00Z",
  },
];

const ARCHIVED_TASK_PAYLOAD = {
  id: "t1",
  title: "Now archived",
  priority: "high",
  archived: true,
  archivedAt: "2026-02-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
};

const RESTORED_TASK_PAYLOAD = {
  id: "t1",
  title: "Now restored",
  priority: "high",
  archived: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("runArchivedList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/archived without query params by default", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ARCHIVED_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/archived");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.tasks).toHaveLength(2);
    expect(report.boardId).toBeUndefined();
  });

  it("appends boardId query param when --board is supplied", async () => {
    const { calls } = scriptFetch([{ status: 200, body: ARCHIVED_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/archived");
    expect(url.searchParams.get("boardId")).toBe("b1");
  });

  it("skips the query string when --board is empty / whitespace", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "   ",
    });
    expect(calls[0].url).not.toContain("?");
  });

  it("renders id / title / archivedAt / priority / assignee by default", async () => {
    scriptFetch([{ status: 200, body: ARCHIVED_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Archived");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("board=b1");
    expect(stdout).toContain("a1");
    expect(stdout).toContain("a2");
    expect(stdout).toContain("Archived one");
    expect(stdout).toContain("Archived two");
    expect(stdout).toContain("2026-01-05T00:00:00Z");
    expect(stdout).toContain("bob");
    expect(stdout).toContain("low");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: ARCHIVED_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.boardId).toBe("b1");
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].id).toBe("a1");
    expect(report.boardId).toBe("b1");
  });

  it("handles an empty archived list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.tasks).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no archived tasks");
  });

  it("coerces a non-array payload into an empty list", async () => {
    scriptFetch([{ status: 200, body: { not: "a list" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runArchivedList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.tasks).toEqual([]);
  });

  it("maps AuthError to NotLoggedInError with a stderr hint", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runArchivedList({
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/not logged in/i);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runArchivedList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runArchivedArchive", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { archived: true } to /api/v1/tasks/:id/archive", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: ARCHIVED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runArchivedArchive(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/t1/archive"
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ archived: true });
    expect(result.archived).toBe(true);
    expect(result.task.archived).toBe(true);
    expect(result.task.id).toBe("t1");
  });

  it("defaults --yes to true so the call works in pipelines", async () => {
    scriptFetch([{ status: 200, body: ARCHIVED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runArchivedArchive(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
  });

  it("prints a confirmation to stdout in table mode", async () => {
    scriptFetch([{ status: 200, body: ARCHIVED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runArchivedArchive(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Archived");
    expect(stdout).toContain("t1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: ARCHIVED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runArchivedArchive(
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
    expect(parsed.id).toBe("t1");
    expect(parsed.archived).toBe(true);
    expect(parsed.task.archived).toBe(true);
    expect(result.id).toBe("t1");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: ARCHIVED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runArchivedArchive(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/a%2Fb%20c/archive"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runArchivedArchive({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runArchivedArchive(
        { apiUrl: "http://kanban.example.com", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runArchivedArchive(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
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
      runArchivedArchive({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("runArchivedRestore", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { archived: false } to /api/v1/tasks/:id/archive", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: RESTORED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runArchivedRestore(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/t1/archive"
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ archived: false });
    expect(result.archived).toBe(false);
    expect(result.task.archived).toBe(false);
  });

  it("prints a Restored confirmation to stdout", async () => {
    scriptFetch([{ status: 200, body: RESTORED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runArchivedRestore(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Restored");
    expect(stdout).toContain("t1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: RESTORED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runArchivedRestore(
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
    expect(parsed.archived).toBe(false);
    expect(parsed.task.archived).toBe(false);
    expect(result.id).toBe("t1");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: RESTORED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runArchivedRestore(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/a%2Fb%20c/archive"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runArchivedRestore({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runArchivedRestore(
        { apiUrl: "http://kanban.example.com", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps 404 to NotFoundError", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runArchivedRestore({ apiUrl: "http://kanban.example.com", http }, "ghost")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps AuthError to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runArchivedRestore({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});