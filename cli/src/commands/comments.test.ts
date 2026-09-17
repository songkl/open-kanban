// Tests for `kanban comments add / list`.
//
// HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover the request shape (URL, method, body, query), the
// JSON output shape, and the tabular rendering. The comments endpoints
// are auth-gated (RequireAuth in backend/cmd/server/main.go) but the
// CLI code defers to the HttpClient for bearer-token plumbing, so the
// mocked fetch simply needs to surface the right URL / body.
//
// stdin reading is covered by injecting a Readable stream via
// io.stdin so the tests don't touch the real process.stdin and can
// script multi-byte / multi-line payloads deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runCommentsAdd,
  runCommentsList,
  STDIN_BODY_SENTINEL,
} from "./comments.js";
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

function readableFromString(text: string): Readable {
  return Readable.from(text);
}

const COMMENT_PAYLOAD = {
  id: "c1",
  content: "Looks good to me",
  author: "alice",
  userId: "u1",
  taskId: "t1",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T03:04:05Z",
};

const COMMENTS_LIST_PAYLOAD = [
  {
    id: "c1",
    content: "First comment",
    author: "alice",
    userId: "u1",
    taskId: "t1",
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T03:04:05Z",
  },
  {
    id: "c2",
    content: "Second comment",
    author: "bob",
    userId: "u2",
    taskId: "t1",
    createdAt: "2026-01-03T03:04:05Z",
    updatedAt: "2026-01-03T03:04:05Z",
  },
];

describe("runCommentsAdd", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { taskId, content } to /api/v1/comments when --body is literal", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: "Looks good to me",
        http,
      },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/comments");
    expect(calls[0].init?.method).toBe("POST");
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody).toEqual({ taskId: "t1", content: "Looks good to me" });
    expect(sentBody).not.toHaveProperty("author");
    expect(result.comment.id).toBe("c1");
    expect(result.comment.content).toBe("Looks good to me");
  });

  it("includes --author in the payload when supplied", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: "ack",
        author: "reviewer-bot",
        http,
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody.author).toBe("reviewer-bot");
  });

  it("drops --author when it's empty or whitespace", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: "ack",
        author: "   ",
        http,
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody).not.toHaveProperty("author");
  });

  it("reads body from stdin when --body is the stdin sentinel", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: STDIN_BODY_SENTINEL,
        http,
        io: { ...cap.io, stdin: readableFromString("LGTM\n") },
      },
      "s-1061"
    );
    expect(calls).toHaveLength(1);
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody).toEqual({ taskId: "s-1061", content: "LGTM" });
    expect(result.comment.id).toBe("c1");
  });

  it("trims surrounding whitespace from stdin content", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: STDIN_BODY_SENTINEL,
        http,
        io: { stdin: readableFromString("\n\n  hello world  \n\n") },
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody.content).toBe("hello world");
  });

  it("preserves multi-line stdin content (interior newlines intact)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const multi = "line one\nline two\nline three";
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: STDIN_BODY_SENTINEL,
        http,
        io: { stdin: readableFromString(multi) },
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody.content).toBe("line one\nline two\nline three");
  });

  it("decodes multi-byte UTF-8 characters from stdin", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: STDIN_BODY_SENTINEL,
        http,
        io: { stdin: readableFromString("中文评论 ✓") },
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody.content).toBe("中文评论 ✓");
  });

  it("throws InvalidUsageError when stdin is empty after trim", async () => {
    scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runCommentsAdd(
        {
          apiUrl: "http://kanban.example.com",
          body: STDIN_BODY_SENTINEL,
          http,
          io: { stdin: readableFromString("   \n\n  ") },
        },
        "t1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("treats a literal --body of '-' (not the sentinel) the same as stdin when stdin exists", async () => {
    // This guards against the sentinel comparison being accidentally inverted.
    const { calls } = scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: STDIN_BODY_SENTINEL,
        http,
        io: { stdin: readableFromString("piped value") },
      },
      "t1"
    );
    const sentBody = JSON.parse((calls[0].init?.body as string) ?? "{}");
    expect(sentBody.content).toBe("piped value");
    // And verify the exact sentinel constant — guard against a future
    // rename accidentally diverging from the public docs.
    expect(STDIN_BODY_SENTINEL).toBe("-");
    expect(calls).toHaveLength(1);
  });

  it("rejects empty literal --body with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runCommentsAdd(
        { apiUrl: "http://kanban.example.com", body: "   ", http },
        "t1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError when task id is missing", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runCommentsAdd(
        { apiUrl: "http://kanban.example.com", body: "hi", http },
        ""
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runCommentsAdd(
        { apiUrl: "http://kanban.example.com", body: "hi", http },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("prints a confirmation to stdout in table mode", async () => {
    scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: "LGTM",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toMatch(/added comment/i);
    expect(stdout).toContain("c1");
    expect(stdout).toContain("t1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: COMMENT_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runCommentsAdd(
      {
        apiUrl: "http://kanban.example.com",
        body: "LGTM",
        format: "json",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.comment.id).toBe("c1");
    expect(parsed.comment.content).toBe("Looks good to me");
    expect(result.apiUrl).toBe("http://kanban.example.com");
  });

  it("maps 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runCommentsAdd(
        {
          apiUrl: "http://kanban.example.com",
          body: "hi",
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
      runCommentsAdd(
        { apiUrl: "http://kanban.example.com", body: "hi", http },
        "t1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runCommentsAdd(
        { apiUrl: "http://kanban.example.com", body: "hi", http },
        "t1"
      )
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runCommentsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/comments?taskId=<id>", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COMMENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runCommentsList(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/comments");
    expect(url.searchParams.get("taskId")).toBe("t1");
    expect(report.comments).toHaveLength(2);
    expect(report.taskId).toBe("t1");
    expect(report.apiUrl).toBe("http://kanban.example.com");
  });

  it("encodes task ids with special characters in the query string", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runCommentsList(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("taskId")).toBe("a/b c");
  });

  it("renders id / author / createdAt / content by default", async () => {
    scriptFetch([{ status: 200, body: COMMENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runCommentsList(
      {
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Comments");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("task=t1");
    expect(stdout).toContain("c1");
    expect(stdout).toContain("c2");
    expect(stdout).toContain("alice");
    expect(stdout).toContain("bob");
    expect(stdout).toContain("First comment");
    expect(stdout).toContain("Second comment");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: COMMENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runCommentsList(
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
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.comments[0].id).toBe("c1");
    expect(parsed.comments[1].id).toBe("c2");
    expect(report.comments).toHaveLength(2);
  });

  it("handles an empty comments list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runCommentsList(
      {
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      },
      "t1"
    );
    expect(report.comments).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no comments");
  });

  it("coerces a non-array payload into an empty list", async () => {
    scriptFetch([{ status: 200, body: { not: "a list" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runCommentsList(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(report.comments).toEqual([]);
  });

  it("throws InvalidUsageError when task id is missing or whitespace", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runCommentsList({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runCommentsList({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps AuthError to NotLoggedInError with a stderr hint", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runCommentsList(
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
      runCommentsList(
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
      runCommentsList({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});
