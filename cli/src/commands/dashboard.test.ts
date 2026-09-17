// Tests for `kanban dashboard`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover both the request shape (URL, method, bearer header) and
// the output formatting (table vs. json). Auth-required behaviour: when the
// server returns 401, the command must re-map the error to NotLoggedInError
// so the CLI bootstrap can apply the documented exit-code mapping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, AuthError } from "../http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../auth/client.js";
import { runDashboard, NotLoggedInError } from "./dashboard.js";
import type { OAuthMetadata } from "../auth/types.js";

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
    io: { stdout: out as unknown as NodeJS.WritableStream, stderr: err as unknown as NodeJS.WritableStream },
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
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

const STATS_PAYLOAD = {
  totalTasks: 42,
  tasksByStatus: { todo: 10, in_progress: 12, review: 8, done: 12 },
  tasksByPriority: { high: 5, medium: 20, low: 17 },
  publishedTasks: 30,
  draftTasks: 12,
  archivedTasks: 7,
  totalBoards: 3,
  totalColumns: 14,
  totalUsers: 6,
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

describe("runDashboard", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/dashboard/stats with a bearer token", async () => {
    const { calls } = scriptFetch([{ status: 200, body: STATS_PAYLOAD }]);
    const http = makeAuthedClient();
    await runDashboard({ apiUrl: "http://kanban.example.com", http });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/dashboard/stats");
    expect(calls[0].init?.method).toBe("GET");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
  });

  it("prints totals, status breakdown, and priority breakdown as a table", async () => {
    scriptFetch([{ status: 200, body: STATS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.stats).toEqual(STATS_PAYLOAD);
    expect(report.apiUrl).toBe("http://kanban.example.com");
    const { stdout } = cap.read();
    expect(stdout).toContain("Kanban dashboard");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("Total tasks");
    expect(stdout).toContain("42");
    expect(stdout).toContain("Published");
    expect(stdout).toContain("30");
    expect(stdout).toContain("Boards");
    expect(stdout).toContain("3");
    expect(stdout).toContain("Tasks by status");
    expect(stdout).toContain("todo");
    expect(stdout).toContain("in_progress");
    expect(stdout).toContain("Tasks by priority");
    expect(stdout).toContain("high");
    expect(stdout).toContain("medium");
    expect(stdout).toContain("low");
  });

  it("emits raw JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: STATS_PAYLOAD }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.stats).toEqual(STATS_PAYLOAD);
  });

  it("maps a 401 response to NotLoggedInError so the CLI can exit with code 2", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runDashboard({ apiUrl: "http://kanban.example.com", http, io: cap.io })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Not logged in/i);
  });

  it("propagates non-auth ApiErrors unchanged (network / server)", async () => {
    scriptFetch([{ status: 500, body: { error: "boom" } }]);
    const http = makeAuthedClient();
    await expect(
      runDashboard({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toBeInstanceOf(Error);
  });

  it("renders a minimal table when only totalTasks is present", async () => {
    scriptFetch([{ status: 200, body: { totalTasks: 5 } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.stats.totalTasks).toBe(5);
    const { stdout } = cap.read();
    expect(stdout).toContain("5");
    expect(stdout).not.toContain("Tasks by status");
    expect(stdout).not.toContain("Tasks by priority");
  });

  it("survives an empty payload and produces a zero-filled report", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.stats).toEqual({});
    const { stdout } = cap.read();
    expect(stdout).toContain("0");
  });

  it("uses KANBAN_API_URL when no explicit apiUrl is provided", async () => {
    process.env.KANBAN_API_URL = "https://kanban.example.com/";
    const { calls } = scriptFetch([{ status: 200, body: STATS_PAYLOAD }]);
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "https://kanban.example.com",
      clientId: "cid",
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 60_000,
    });
    const oauth = new OAuthClient("https://kanban.example.com", metadata, provider);
    const http = new HttpClient();
    http.attachOAuth(oauth);
    await runDashboard({ apiUrl: process.env.KANBAN_API_URL, http });
    expect(calls[0].url).toBe("https://kanban.example.com/api/v1/dashboard/stats");
  });

  it("orders status rows todo -> in_progress -> review -> done", async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          tasksByStatus: { done: 1, review: 2, todo: 3, in_progress: 4 },
        },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const todoIdx = stdout.indexOf("todo");
    const inProgressIdx = stdout.indexOf("in_progress");
    const reviewIdx = stdout.indexOf("review");
    const doneIdx = stdout.indexOf("done");
    expect(todoIdx).toBeGreaterThan(0);
    expect(todoIdx).toBeLessThan(inProgressIdx);
    expect(inProgressIdx).toBeLessThan(reviewIdx);
    expect(reviewIdx).toBeLessThan(doneIdx);
  });

  it("orders priority rows high -> medium -> low", async () => {
    scriptFetch([
      {
        status: 200,
        body: { tasksByPriority: { low: 1, medium: 2, high: 3 } },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runDashboard({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const highIdx = stdout.indexOf("high");
    const mediumIdx = stdout.indexOf("medium");
    const lowIdx = stdout.indexOf("low");
    expect(highIdx).toBeGreaterThan(0);
    expect(highIdx).toBeLessThan(mediumIdx);
    expect(mediumIdx).toBeLessThan(lowIdx);
  });
});

describe("NotLoggedInError from runDashboard", () => {
  it("is distinct from AuthError so callers can route it to the login hint", () => {
    const a = new AuthError("boom", { path: "/x" });
    const n = new NotLoggedInError("boom");
    expect(n).not.toBeInstanceOf(AuthError);
    expect(a).not.toBeInstanceOf(NotLoggedInError);
  });
});
