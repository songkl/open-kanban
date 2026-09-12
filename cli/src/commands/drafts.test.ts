// Tests for `kanban drafts list / publish / unpublish`.
//
// HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover the request shape (URL, method, body), the JSON
// output shape, and the tabular rendering. The drafts endpoints are
// auth-gated (RequireAuth in backend/cmd/server/main.go) but the CLI
// code defers to the HttpClient for bearer-token plumbing, so the
// mocked fetch simply needs to surface the right URL / body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runDraftsList,
  runDraftsPublish,
  runDraftsUnpublish,
} from "./drafts.js";
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

const DRAFTS_PAYLOAD = [
  {
    id: "d1",
    title: "First draft",
    priority: "high",
    assignee: "alice",
    published: false,
    archived: false,
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "d2",
    title: "Second draft",
    priority: "medium",
    assignee: null,
    published: false,
    archived: false,
    createdAt: "2026-01-02T00:00:00Z",
  },
];

const PUBLISHED_TASK_PAYLOAD = {
  id: "d1",
  title: "First draft",
  priority: "high",
  assignee: "alice",
  published: true,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
};

const UNPUBLISHED_TASK_PAYLOAD = {
  id: "d1",
  title: "First draft",
  priority: "high",
  assignee: "alice",
  published: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("runDraftsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/drafts without query params by default", async () => {
    const { calls } = scriptFetch([{ status: 200, body: DRAFTS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/drafts");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.drafts).toHaveLength(2);
    expect(report.boardId).toBeUndefined();
  });

  it("appends boardId query param when --board is supplied", async () => {
    const { calls } = scriptFetch([{ status: 200, body: DRAFTS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/drafts");
    expect(url.searchParams.get("boardId")).toBe("b1");
  });

  it("skips the query string when --board is empty / whitespace", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "   ",
    });
    expect(calls[0].url).not.toContain("?");
  });

  it("renders id / title / priority / assignee / createdAt by default", async () => {
    scriptFetch([{ status: 200, body: DRAFTS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Drafts");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("board=b1");
    expect(stdout).toContain("d1");
    expect(stdout).toContain("d2");
    expect(stdout).toContain("First draft");
    expect(stdout).toContain("Second draft");
    expect(stdout).toContain("alice");
    expect(stdout).toContain("high");
    expect(stdout).toContain("medium");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: DRAFTS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runDraftsList({
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
    expect(parsed.drafts).toHaveLength(2);
    expect(parsed.drafts[0].id).toBe("d1");
    expect(report.boardId).toBe("b1");
  });

  it("handles an empty drafts list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.drafts).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no drafts");
  });

  it("coerces a non-array payload into an empty list", async () => {
    scriptFetch([{ status: 200, body: { not: "a list" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runDraftsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.drafts).toEqual([]);
  });

  it("maps AuthError to NotLoggedInError with a stderr hint", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runDraftsList({
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
      runDraftsList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runDraftsPublish", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs { published: true } to /api/v1/tasks/:id", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: PUBLISHED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runDraftsPublish(
      { apiUrl: "http://kanban.example.com", http },
      "d1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/d1");
    expect(calls[0].init?.method).toBe("PUT");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ published: true });
    expect(result.published).toBe(true);
    expect(result.task.id).toBe("d1");
    expect(result.task.published).toBe(true);
  });

  it("prints a confirmation to stdout in table mode", async () => {
    scriptFetch([{ status: 200, body: PUBLISHED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runDraftsPublish(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "d1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Published");
    expect(stdout).toContain("d1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: PUBLISHED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runDraftsPublish(
      {
        apiUrl: "http://kanban.example.com",
        http,
        format: "json",
        io: cap.io,
      },
      "d1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.id).toBe("d1");
    expect(parsed.published).toBe(true);
    expect(parsed.task.published).toBe(true);
    expect(result.id).toBe("d1");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: PUBLISHED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runDraftsPublish(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/a%2Fb%20c"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runDraftsPublish({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runDraftsPublish(
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
      runDraftsPublish(
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
      runDraftsPublish({ apiUrl: "http://kanban.example.com", http }, "d1")
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("runDraftsUnpublish", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs { published: false } to /api/v1/tasks/:id", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UNPUBLISHED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runDraftsUnpublish(
      { apiUrl: "http://kanban.example.com", http },
      "d1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/d1");
    expect(calls[0].init?.method).toBe("PUT");
    const body = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(body).toEqual({ published: false });
    expect(result.published).toBe(false);
    expect(result.task.published).toBe(false);
  });

  it("prints an Unpublished confirmation to stdout", async () => {
    scriptFetch([{ status: 200, body: UNPUBLISHED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runDraftsUnpublish(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "d1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Unpublished");
    expect(stdout).toContain("d1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: UNPUBLISHED_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runDraftsUnpublish(
      {
        apiUrl: "http://kanban.example.com",
        http,
        format: "json",
        io: cap.io,
      },
      "d1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.published).toBe(false);
    expect(parsed.task.published).toBe(false);
    expect(result.id).toBe("d1");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: UNPUBLISHED_TASK_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runDraftsUnpublish(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/a%2Fb%20c"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runDraftsUnpublish({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runDraftsUnpublish(
        { apiUrl: "http://kanban.example.com", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps 404 to NotFoundError", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runDraftsUnpublish({ apiUrl: "http://kanban.example.com", http }, "ghost")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps AuthError to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runDraftsUnpublish({ apiUrl: "http://kanban.example.com", http }, "d1")
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});