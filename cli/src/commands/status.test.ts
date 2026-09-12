// Tests for `kanban status`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover both the request shape (URL, method, headers) and the
// output formatting (table vs. json). The fetch spy is reset between cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NetworkError } from "../http/client.js";
import { runStatus } from "./status.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
  delayMs?: number;
}

function scriptFetch(responses: ScriptedResponse[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    }
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

const BOARDS_PAYLOAD = [
  {
    id: "b1",
    name: "Alpha",
    description: "first board",
    deleted: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    _count: { columns: 4 },
  },
  {
    id: "b2",
    name: "Beta",
    description: "second board",
    deleted: false,
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    _count: { columns: 3 },
  },
];

describe("runStatus", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/boards and reports latency / boardsCount / apiUrl", async () => {
    const { calls } = scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/boards");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.apiUrl).toBe("http://kanban.example.com");
    expect(report.status).toBe("online");
    expect(report.boardsCount).toBe(2);
    expect(report.boards).toEqual([
      { id: "b1", name: "Alpha", columns: 4 },
      { id: "b2", name: "Beta", columns: 3 },
    ]);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    const { stdout, stderr } = cap.read();
    expect(stdout).toContain("Kanban API");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("online");
    expect(stdout).toContain("2");
    expect(stdout).toContain("Alpha");
    expect(stdout).toContain("Beta");
    expect(stderr).toBe("");
  });

  it("formats output as JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.boardsCount).toBe(2);
    expect(parsed.status).toBe("online");
    expect(parsed.boards).toEqual([
      { id: "b1", name: "Alpha", columns: 4 },
      { id: "b2", name: "Beta", columns: 3 },
    ]);
    expect(parsed.latencyMs).toBe(report.latencyMs);
  });

  it("reports offline + the error message when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.status).toBe("offline");
    expect(report.boardsCount).toBe(0);
    expect(report.error).toMatch(/ECONNREFUSED|network/i);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/network|ECONNREFUSED/i);
  });

  it("reports offline when the server returns a non-2xx status", async () => {
    scriptFetch([{ status: 500, body: { error: "boom" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.status).toBe("offline");
    expect(report.boardsCount).toBe(0);
    expect(report.error).toMatch(/500/);
  });

  it("uses KANBAN_API_URL when no explicit apiUrl is provided", async () => {
    process.env.KANBAN_API_URL = "https://kanban.example.com/";
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient();
    await runStatus({ apiUrl: process.env.KANBAN_API_URL, http });
    expect(calls[0].url).toBe("https://kanban.example.com/api/v1/boards");
  });

  it("measures latency against the actual server round-trip", async () => {
    scriptFetch([{ status: 200, body: [], delayMs: 25 }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.latencyMs).toBeGreaterThanOrEqual(20);
  });

  it("wraps raw board payload into BoardSummary entries (ignoring description / timestamps)", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
    });
    for (const board of report.boards) {
      expect(Object.keys(board).sort()).toEqual(["columns", "id", "name"]);
    }
  });

  it("handles an empty boards list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.boardsCount).toBe(0);
    expect(report.boards).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("0");
    expect(stdout).not.toContain("Boards:");
  });

  it("falls back to 0 columns when _count is missing", async () => {
    scriptFetch([{ status: 200, body: [{ id: "b1", name: "NoCount" }] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runStatus({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.boards[0]).toEqual({ id: "b1", name: "NoCount", columns: 0 });
  });

  it("attaches no Authorization header (the boards endpoint is public)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runStatus({ apiUrl: "http://kanban.example.com", http });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("runStatus network-error classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an offline report without throwing when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runStatus({ apiUrl: "http://kanban.example.com", http })
    ).resolves.toMatchObject({ status: "offline" });
  });

  it("captures NetworkError messages verbatim in the report", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new NetworkError("network error contacting http://x/api/v1/boards");
    });
    const report = await runStatus({ apiUrl: "http://kanban.example.com", http });
    expect(report.error).toContain("network error");
  });
});
