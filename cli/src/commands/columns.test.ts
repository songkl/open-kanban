// Tests for `kanban columns list` and `kanban columns get`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so the
// assertions cover both the request shape (URL, query string) and the
// output formatting (table vs. json). The columns endpoints are public
// (registered in backend/cmd/server/main.go before the RequireAuth
// middleware), so no OAuth bearer token is attached.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, NotFoundError } from "../http/client.js";
import {
  runColumnsList,
  runColumnsGet,
} from "./columns.js";
import { InvalidUsageError } from "./boards.js";

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

const COLUMNS_PAYLOAD = [
  {
    id: "c1",
    name: "Todo",
    status: "todo",
    position: 0,
    color: "#6b7280",
    description: "todo column",
    boardId: "b1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  },
  {
    id: "c2",
    name: "Done",
    status: "done",
    position: 1,
    color: "#22c55e",
    description: "done column",
    boardId: "b1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  },
];

const SINGLE_COLUMN_PAYLOAD = {
  id: "c1",
  name: "Todo",
  status: "todo",
  position: 0,
  color: "#6b7280",
  description: "todo column",
  boardId: "b1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

describe("runColumnsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/columns without query params by default", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/columns");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.columns).toHaveLength(2);
    expect(report.boardId).toBeUndefined();
    expect(report.positions).toBeUndefined();
  });

  it("appends boardId and positions query params", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      positions: [3, 1, 5],
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/columns");
    expect(url.searchParams.get("boardId")).toBe("b1");
    expect(url.searchParams.get("positions")).toBe("1,3,5");
  });

  it("skips the query string when no filter arguments are provided", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runColumnsList({ apiUrl: "http://kanban.example.com", http });
    expect(calls[0].url).not.toContain("?");
  });

  it("includes only boardId when positions is empty", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      positions: [],
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("boardId")).toBe("b1");
    expect(url.searchParams.get("positions")).toBeNull();
  });

  it("renders id / name / boardId / position / status columns by default", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Columns");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("board=b1");
    expect(stdout).toContain("c1");
    expect(stdout).toContain("c2");
    expect(stdout).toContain("Todo");
    expect(stdout).toContain("Done");
    expect(stdout).toContain("todo");
    expect(stdout).toContain("done");
  });

  it("emits JSON when format=json and surfaces the filter in the report", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      positions: [1, 2],
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.boardId).toBe("b1");
    expect(parsed.positions).toEqual([1, 2]);
    expect(parsed.columns).toHaveLength(2);
    expect(report.boardId).toBe("b1");
    expect(report.positions).toEqual([1, 2]);
  });

  it("emits YAML when format=yaml", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      format: "yaml",
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("apiUrl: http://kanban.example.com");
    expect(stdout).toContain("columns:");
    expect(stdout).toContain("id: c1");
    expect(stdout).not.toContain("┌"); // no table box drawing
  });

  it("honors --fields projection", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: ["id", "color"],
    });
    expect(Object.keys(report.columns[0]).sort()).toEqual(["color", "id"]);
  });

  it("ignores unknown field names and falls back to defaults", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: ["bogus"],
    });
    expect(Object.keys(report.columns[0]).sort()).toEqual([
      "boardId",
      "id",
      "name",
      "position",
      "status",
    ]);
  });

  it("handles an empty columns list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runColumnsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.columns).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no columns");
  });

  it("rejects non-numeric position values with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runColumnsList({
        apiUrl: "http://kanban.example.com",
        http,
        positions: [Number.NaN],
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runColumnsList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/ETIMEDOUT|network/i);
  });
});

describe("runColumnsGet", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/columns/:id with the supplied id", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runColumnsGet(
      { apiUrl: "http://kanban.example.com", http },
      "c1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/columns/c1");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.column.id).toBe("c1");
    expect(report.column.name).toBe("Todo");
  });

  it("renders full column details as a table", async () => {
    scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runColumnsGet(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "c1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Column");
    expect(stdout).toContain("c1");
    expect(stdout).toContain("Todo");
    expect(stdout).toContain("b1");
    expect(stdout).toContain("#6b7280");
    expect(stdout).toContain("todo column");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runColumnsGet(
      { apiUrl: "http://kanban.example.com", http, format: "json", io: cap.io },
      "c1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.column.id).toBe("c1");
  });

  it("honors --fields projection", async () => {
    scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runColumnsGet(
      {
        apiUrl: "http://kanban.example.com",
        http,
        fields: ["id", "name"],
        format: "json",
        io: cap.io,
      },
      "c1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(Object.keys(parsed.column).sort()).toEqual(["id", "name"]);
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runColumnsGet(
      { apiUrl: "http://kanban.example.com", http },
      "a/b c"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/columns/a%2Fb%20c"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runColumnsGet({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runColumnsGet({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 as NotFoundError and writes a hint to stderr", async () => {
    scriptFetch([{ status: 404, body: { error: "Column not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runColumnsGet(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/column not found/i);
  });

  it("does not attach an Authorization header (the columns endpoint is public)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_COLUMN_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runColumnsGet({ apiUrl: "http://kanban.example.com", http }, "c1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
