// Tests for `kanban runs list`.
//
// `runRunsList` calls GET /api/v1/runs/history and parses query
// params out of the supplied flags (--runner-id, --since,
// --status, --task, --board, --limit, --offset). HttpClient is
// exercised through vi.spyOn(globalThis, "fetch") so the assertions
// cover both the request shape (URL, query string, method) and
// the rendering (table vs JSON/YAML), plus the input-validation
// paths for the relative --since parser and the --status
// allow-list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient } from "../http/client.js";
import {
  runRunsList,
  parseSince,
  InvalidRunStatusError,
  InvalidSinceError,
  type TaskRun,
} from "./runs.js";
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

const RUN_PAYLOAD: TaskRun[] = [
  {
    taskId: "task-1",
    runnerId: "runner-A",
    agentId: "agent-1",
    boardId: "board-1",
    columnId: "col-1",
    status: "completed",
    claimedAt: "2026-09-12T10:00:00Z",
    lastHeartbeatAt: "2026-09-12T10:00:30Z",
    expiresAt: "2026-09-12T10:05:00Z",
    finishedAt: "2026-09-12T10:01:00Z",
    exitCode: 0,
    error: null,
  },
  {
    taskId: "task-2",
    runnerId: "runner-B",
    agentId: "agent-2",
    boardId: "board-1",
    columnId: "col-2",
    status: "failed",
    claimedAt: "2026-09-12T09:00:00Z",
    lastHeartbeatAt: "2026-09-12T09:00:15Z",
    expiresAt: "2026-09-12T09:05:00Z",
    finishedAt: "2026-09-12T09:00:42Z",
    exitCode: 1,
    error: "agent crashed",
  },
  {
    taskId: "task-3",
    runnerId: "runner-A",
    agentId: "agent-1",
    boardId: "board-2",
    columnId: "col-3",
    status: "released",
    claimedAt: "2026-09-11T08:00:00Z",
    lastHeartbeatAt: "2026-09-11T08:01:00Z",
    expiresAt: "2026-09-11T08:06:00Z",
    finishedAt: "2026-09-11T08:05:30Z",
    exitCode: null,
    error: "released",
  },
];

describe("parseSince", () => {
  const now = new Date("2026-09-13T00:00:00Z");

  it("resolves relative duration 1d to a UTC ISO timestamp 1 day back", () => {
    expect(parseSince("1d", now)).toBe("2026-09-12T00:00:00Z");
  });

  it("supports all relative units (s, m, h, d, w)", () => {
    expect(parseSince("45s", now)).toBe("2026-09-12T23:59:15Z");
    expect(parseSince("30m", now)).toBe("2026-09-12T23:30:00Z");
    expect(parseSince("2h", now)).toBe("2026-09-12T22:00:00Z");
    expect(parseSince("1d", now)).toBe("2026-09-12T00:00:00Z");
    expect(parseSince("1w", now)).toBe("2026-09-06T00:00:00Z");
  });

  it("accepts whitespace between the number and the unit", () => {
    expect(parseSince("1 d", now)).toBe("2026-09-12T00:00:00Z");
  });

  it("forwards YYYY-MM-DD timestamps verbatim", () => {
    expect(parseSince("2026-09-01", now)).toBe("2026-09-01");
  });

  it("forwards RFC3339 timestamps verbatim", () => {
    expect(parseSince("2026-09-01T12:34:56Z", now)).toBe(
      "2026-09-01T12:34:56Z"
    );
  });

  it("rejects empty input", () => {
    expect(() => parseSince("", now)).toThrow(InvalidSinceError);
    expect(() => parseSince("   ", now)).toThrow(InvalidSinceError);
  });

  it("rejects unknown units", () => {
    expect(() => parseSince("5y", now)).toThrow(InvalidSinceError);
  });

  it("rejects unknown strings that aren't a duration or date", () => {
    expect(() => parseSince("not-a-date", now)).toThrow(InvalidSinceError);
  });
});

describe("runRunsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/runs/history without query params by default", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/runs/history"
    );
    expect(calls[0].init?.method).toBe("GET");
    expect(report.runs).toHaveLength(3);
    expect(report.runnerId).toBeUndefined();
    expect(report.status).toBeUndefined();
  });

  it("forwards --runner-id as runnerId query param", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      runnerId: "runner-A",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/runs/history");
    expect(url.searchParams.get("runnerId")).toBe("runner-A");
  });

  it("forwards --status as status query param (lowercased)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      status: "Completed",
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("status")).toBe("completed");
  });

  it("resolves --since 1d to a `from` query param", async () => {
    const now = new Date("2026-09-13T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      await runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        since: "1d",
      });
      const url = new URL(calls[0].url);
      expect(url.searchParams.get("from")).toBe("2026-09-12T00:00:00Z");
      expect(url.searchParams.has("to")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards --since absolute timestamps unchanged", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      since: "2026-09-01",
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("from")).toBe("2026-09-01");
  });

  it("forwards --task and --board as their respective query params", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      taskId: "task-1",
      boardId: "board-1",
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("taskId")).toBe("task-1");
    expect(url.searchParams.get("boardId")).toBe("board-1");
  });

  it("forwards --limit and --offset as numeric query params", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      limit: 10,
      offset: 20,
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
  });

  it("skips the query string when no filters are provided", async () => {
    const { calls } = scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      runnerId: "   ",
      since: "  ",
    });
    expect(calls[0].url).not.toContain("?");
  });

  it("rejects unknown --status values with InvalidRunStatusError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        status: "bogus",
      })
    ).rejects.toBeInstanceOf(InvalidRunStatusError);
  });

  it("rejects unknown --since values with InvalidSinceError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        since: "bogus",
      })
    ).rejects.toBeInstanceOf(InvalidSinceError);
  });

  it("rejects non-positive --limit and negative --offset", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        limit: 0,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        offset: -1,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("renders a tabular summary by default with filter subtitle", async () => {
    scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      runnerId: "runner-A",
      status: "completed",
      since: "1d",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Runs");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("runner=runner-A");
    expect(stdout).toContain("status=completed");
    expect(stdout).toContain("task-1");
    expect(stdout).toContain("task-2");
    expect(stdout).toContain("task-3");
    expect(stdout).toContain("runner-A");
    expect(stdout).toContain("runner-B");
  });

  it("renders durations in a human-friendly form", async () => {
    scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("1m");
    expect(stdout).toContain("42s");
    expect(stdout).toContain("5m30s");
  });

  it("emits JSON when format=json with the supplied filter echo", async () => {
    scriptFetch([{ status: 200, body: RUN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      runnerId: "runner-A",
      status: "completed",
      since: "1d",
      format: "json",
      io: cap.io,
    });
    const parsed = JSON.parse(cap.read().stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.runnerId).toBe("runner-A");
    expect(parsed.status).toBe("completed");
    expect(parsed.since).toBe("1d");
    expect(parsed.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.runs).toHaveLength(3);
    expect(parsed.runs[0].taskId).toBe("task-1");
    expect(report.runs).toHaveLength(3);
  });

  it("handles an empty run list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.runs).toEqual([]);
    expect(cap.read().stdout).toContain("no runs");
  });

  it("coerces a non-array payload into an empty list", async () => {
    scriptFetch([{ status: 200, body: { not: "a list" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runRunsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.runs).toEqual([]);
  });

  it("maps AuthError to NotLoggedInError with a stderr hint", async () => {
    scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runRunsList({
        apiUrl: "http://kanban.example.com",
        http,
        io: cap.io,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(cap.read().stderr).toMatch(/not logged in/i);
  });
});
