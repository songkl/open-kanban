// Tests for `kanban mine [--lightweight]`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover both the request shape (URL, bearer header) and the
// output formatting (table vs. json). The /api/v1/mcp/my-tasks endpoint is
// auth-required, so the happy-path tests use a bearer-token HttpClient.
// `--board <id>` is accepted but deliberately forwarded to stderr as a
// warning (the backend does not currently accept a boardId query parameter
// on this endpoint); the test asserts the URL stays free of `?boardId=`
// even when --board is supplied.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, AuthError } from "../http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../auth/client.js";
import type { OAuthMetadata } from "../auth/types.js";
import { runMine, NotLoggedInError } from "./mine.js";

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
    reset() {
      stdout = "";
      stderr = "";
    },
  };
}

const metadata: OAuthMetadata = {
  issuer: "http://kanban.example.com",
  authorization_endpoint: "http://kanban.example.com/oauth/authorize",
  token_endpoint: "http://kanban.example.com/oauth/token",
  jwks_uri: "http://kanban.example.com/.well-known/jwks.json",
  registration_endpoint: "http://kanban.example.com/oauth/register",
  device_authorization_endpoint: "http://kanban.example.com/oauth/device/code",
  grant_types_supported: [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

function makeAuthedClient(): HttpClient {
  const provider = new InMemorySecretProvider();
  provider.write({
    apiUrl: "http://kanban.example.com",
    clientId: "cid",
    accessToken: "at-fresh",
    refreshToken: "rt",
    accessExpiresAt: Date.now() + 60_000,
  });
  const oauth = new OAuthClient("http://kanban.example.com", metadata, provider);
  const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
  http.attachOAuth(oauth);
  return http;
}

const TASKS_PAYLOAD = {
  tasks: [
    {
      id: "t1",
      title: "Refactor auth middleware",
      priority: "high",
      assignee: "agent-7",
      columnId: "col-doing",
      columnName: "进行中",
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-11T00:00:00Z",
      _count: { comments: 2, subtasks: 1 },
    },
    {
      id: "t2",
      title: "Write CLI smoke tests",
      priority: "medium",
      assignee: "agent-7",
      columnId: "col-todo",
      columnName: "待办",
      createdAt: "2026-09-12T00:00:00Z",
      updatedAt: "2026-09-12T00:00:00Z",
      _count: { comments: 0, subtasks: 0 },
    },
  ],
  total: 2,
  userAgent: "agent-7",
};

describe("runMine", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/mcp/my-tasks with a bearer token", async () => {
    const { calls } = scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    await runMine({ apiUrl: "http://kanban.example.com", http });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/mcp/my-tasks");
    expect(calls[0].init?.method).toBe("GET");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
  });

  it("prints the agent's tasks as a table by default", async () => {
    scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.total).toBe(2);
    expect(report.userAgent).toBe("agent-7");
    expect(report.lightweight).toBe(false);
    expect(report.tasks).toHaveLength(2);
    const { stdout } = cap.read();
    expect(stdout).toContain("My tasks");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("agent=agent-7");
    expect(stdout).toContain("Refactor auth middleware");
    expect(stdout).toContain("进行中");
    expect(stdout).toContain("agent-7");
  });

  it("emits raw JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.userAgent).toBe("agent-7");
    expect(parsed.total).toBe(2);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].id).toBe("t1");
  });

  it("drops the columnName column when --lightweight is set", async () => {
    scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      lightweight: true,
      io: cap.io,
    });
    expect(report.lightweight).toBe(true);
    const { stdout } = cap.read();
    expect(stdout).toContain("lightweight");
    expect(stdout).not.toContain("column");
    const firstRow = report.tasks[0] as Record<string, unknown>;
    expect(firstRow).not.toHaveProperty("columnName");
  });

  it("keeps the URL free of boardId when --board is supplied (warning on stderr)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "sys",
      io: cap.io,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/mcp/my-tasks");
    expect(calls[0].url).not.toContain("boardId");
    expect(report.total).toBe(2);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/--board is not supported/i);
    expect(stderr).toContain("sys");
  });

  it("does not warn when --board is omitted", async () => {
    scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stderr } = cap.read();
    expect(stderr).not.toMatch(/--board is not supported/i);
  });

  it("ignores whitespace-only --board values without warning", async () => {
    scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "   ",
      io: cap.io,
    });
    const { stderr } = cap.read();
    expect(stderr).not.toMatch(/--board is not supported/i);
  });

  it("maps a 401 response to NotLoggedInError so the CLI can exit with code 2", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runMine({ apiUrl: "http://kanban.example.com", http, io: cap.io })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Not logged in/i);
  });

  it("propagates non-auth ApiErrors unchanged (network / server)", async () => {
    scriptFetch([{ status: 500, body: { error: "boom" } }]);
    const http = makeAuthedClient();
    await expect(
      runMine({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toBeInstanceOf(Error);
  });

  it("survives an empty payload and produces a zero-filled report", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.total).toBe(0);
    expect(report.tasks).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("(no tasks)");
  });

  it("handles a payload with an empty tasks array", async () => {
    scriptFetch([{ status: 200, body: { tasks: [], total: 0 } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runMine({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.total).toBe(0);
    expect(report.tasks).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("(no tasks)");
  });

  it("uses KANBAN_API_URL when no explicit apiUrl is provided", async () => {
    process.env.KANBAN_API_URL = "https://kanban.example.com/";
    const { calls } = scriptFetch([{ status: 200, body: TASKS_PAYLOAD }]);
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "https://kanban.example.com",
      clientId: "cid",
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 60_000,
    });
    const oauth = new OAuthClient(
      "https://kanban.example.com",
      metadata,
      provider
    );
    const http = new HttpClient();
    http.attachOAuth(oauth);
    await runMine({ apiUrl: process.env.KANBAN_API_URL, http });
    expect(calls[0].url).toBe("https://kanban.example.com/api/v1/mcp/my-tasks");
  });
});

describe("NotLoggedInError from runMine", () => {
  it("is distinct from AuthError so callers can route it to the login hint", () => {
    const a = new AuthError("boom", { path: "/x" });
    const n = new NotLoggedInError("boom");
    expect(n).not.toBeInstanceOf(AuthError);
    expect(a).not.toBeInstanceOf(NotLoggedInError);
  });
});
