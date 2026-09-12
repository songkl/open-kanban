// Tests for `kanban boards list` and `kanban boards get`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover both the request shape (URL, method, query string) and
// the output formatting (table vs. json). The boards endpoints are public,
// so no OAuth bearer token is attached and no AuthError mapping is needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runBoardsList,
  runBoardsGet,
  InvalidUsageError,
} from "./boards.js";

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
  };
}

const BOARDS_PAYLOAD = [
  {
    id: "b1",
    name: "Alpha",
    description: "first board",
    shortAlias: "ALP",
    deleted: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    _count: { columns: 4 },
  },
  {
    id: "b2",
    name: "Beta",
    description: "second board",
    shortAlias: "BET",
    deleted: false,
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    _count: { columns: 3 },
  },
];

const SINGLE_BOARD_PAYLOAD = {
  id: "b1",
  name: "Alpha",
  description: "first board",
  shortAlias: "ALP",
  deleted: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  _count: { columns: 4 },
};

describe("runBoardsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/boards with the default field set", async () => {
    const { calls } = scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/boards");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.boards).toHaveLength(2);
    expect(report.boards[0].id).toBe("b1");
    expect(report.boards[0].name).toBe("Alpha");
    expect(report.boards[0].createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("renders id / name / createdAt columns by default", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Boards");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("id");
    expect(stdout).toContain("name");
    expect(stdout).toContain("createdAt");
    expect(stdout).toContain("Alpha");
    expect(stdout).toContain("Beta");
    expect(stdout).toContain("2026-01-01T00:00:00Z");
  });

  it("emits raw JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.boards).toHaveLength(2);
    expect(parsed.boards[0]).toMatchObject({
      id: "b1",
      name: "Alpha",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(report.boards[0]).toEqual({
      id: "b1",
      name: "Alpha",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("emits YAML when format=yaml", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      format: "yaml",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("apiUrl: http://kanban.example.com");
    expect(stdout).toContain("boards:");
    expect(stdout).toContain("id: b1");
    expect(stdout).toContain("name: Alpha");
    expect(stdout).not.toContain("┌"); // no table box drawing
  });

  it("honors --fields for the default and json output", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: ["id", "columnCount"],
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(Object.keys(parsed.boards[0]).sort()).toEqual(["_count", "id"]);
    expect(parsed.boards[0]._count.columns).toBe(4);
    expect(report.boards[0]._count?.columns).toBe(4);
  });

  it("ignores unknown field names and falls back to defaults", async () => {
    scriptFetch([{ status: 200, body: BOARDS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: ["bogus"],
    });
    expect(Object.keys(report.boards[0]).sort()).toEqual([
      "createdAt",
      "id",
      "name",
    ]);
  });

  it("handles an empty boards list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.boards).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Boards");
    expect(stdout).toContain("no boards");
  });

  it("survives a missing _count and reports 0 columns", async () => {
    scriptFetch([{ status: 200, body: [{ id: "b1", name: "Alpha", createdAt: "x" }] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runBoardsList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: ["id", "name", "columnCount"],
    });
    expect(report.boards[0]._count?.columns).toBe(0);
  });

  it("strips a trailing slash from apiUrl", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com/" });
    await runBoardsList({ apiUrl: "http://kanban.example.com/", http });
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/boards");
  });

  it("propagates network errors as NetworkError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runBoardsList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/network|ECONNREFUSED/i);
  });

  it("propagates server errors as ApiError subclasses", async () => {
    scriptFetch([{ status: 500, body: { error: "boom" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runBoardsList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/500/);
  });
});

describe("runBoardsGet", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/boards/:id with the supplied id", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runBoardsGet(
      { apiUrl: "http://kanban.example.com", http },
      "b1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/boards/b1");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.board.id).toBe("b1");
    expect(report.board.name).toBe("Alpha");
  });

  it("renders full board details as a table", async () => {
    scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsGet(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "b1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Board");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("b1");
    expect(stdout).toContain("Alpha");
    expect(stdout).toContain("first board");
    expect(stdout).toContain("ALP");
    expect(stdout).toContain("columns:");
    expect(stdout).toContain("4");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsGet(
      { apiUrl: "http://kanban.example.com", http, format: "json", io: cap.io },
      "b1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.board.id).toBe("b1");
  });

  it("honors --fields projection", async () => {
    scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsGet(
      {
        apiUrl: "http://kanban.example.com",
        http,
        fields: ["id", "name"],
        format: "json",
        io: cap.io,
      },
      "b1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(Object.keys(parsed.board).sort()).toEqual(["id", "name"]);
  });

  it("emits YAML when format=yaml", async () => {
    scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runBoardsGet(
      { apiUrl: "http://kanban.example.com", http, format: "yaml", io: cap.io },
      "b1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("apiUrl: http://kanban.example.com");
    expect(stdout).toContain("board:");
    expect(stdout).toContain("  id: b1"); // 2-space indent under board:
    expect(stdout).toContain("name: Alpha");
    expect(stdout).not.toContain("┌"); // no table box drawing
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runBoardsGet(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/boards/a%2Fb%20c");
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runBoardsGet({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runBoardsGet({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 as NotFoundError and writes a hint to stderr", async () => {
    scriptFetch([{ status: 404, body: { error: "Board not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runBoardsGet(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/board not found/i);
  });

  it("does not attach an Authorization header (the boards endpoint is public)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_BOARD_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runBoardsGet({ apiUrl: "http://kanban.example.com", http }, "b1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
