// Tests for `kanban workspace upload / batch-upload / list / read / delete / stats`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so
// the assertions cover both the request shape (URL, method, body) and
// the output formatting (table vs. json, text mode vs. base64 mode).
// The workspace endpoints live behind RequireSignatureVerification +
// RequireAuth, but the HttpClient handles bearer-token plumbing, so
// the mocked fetch only has to surface the right URL / body.
//
// The two scenarios called out in the task description are:
//   1. The local file path supplied to `upload` does not exist on
//      disk — this must surface as InvalidUsageError so the CLI exits
//      with code 1 instead of a network error.
//   2. `read <id> --output json` must base64-encode the file content
//      so binary payloads survive a JSON round trip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { HttpClient } from "../http/client.js";
import {
  runWorkspaceUpload,
  runWorkspaceBatchUpload,
  runWorkspaceList,
  runWorkspaceRead,
  runWorkspaceDelete,
  runWorkspaceStats,
} from "./workspace.js";
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

async function makeLocalFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kanban-ws-"));
  const file = path.join(dir, name);
  await writeFile(file, contents, "utf8");
  return file;
}

const UPLOAD_RESPONSE = { path: "foo.txt", size: 11 };
const BATCH_RESPONSE = {
  "foo.txt": { path: "foo.txt", size: 11 },
  "bar.txt": { path: "bar.txt", size: 7 },
};
const FILES_RESPONSE = {
  files: [
    {
      name: "foo.txt",
      path: "foo.txt",
      isDir: false,
      size: 11,
      modified: 1700000000,
    },
    {
      name: "nested",
      path: "nested",
      isDir: true,
      size: 0,
      modified: 1700000001,
    },
  ],
};
const READ_RESPONSE = { content: "hello world", size: 11 };
const STATS_RESPONSE = {
  totalFiles: 5,
  totalSize: 1234,
  fileCount: 4,
  directoryCount: 1,
};

describe("runWorkspaceUpload", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the local file and POSTs { path, content } to /api/v1/workspace/upload", async () => {
    const file = await makeLocalFile("foo.txt", "hello world");
    try {
      const { calls } = scriptFetch([{ status: 200, body: UPLOAD_RESPONSE }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const cap = makeCapture();
      const result = await runWorkspaceUpload({
        apiUrl: "http://kanban.example.com",
        file,
        http,
        io: cap.io,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "http://kanban.example.com/api/v1/workspace/upload"
      );
      expect(calls[0].init?.method).toBe("POST");
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.path).toBe("foo.txt");
      expect(body.content).toBe("hello world");
      expect(result.path).toBe("foo.txt");
      expect(result.size).toBe(11);
      const { stdout } = cap.read();
      expect(stdout).toContain("Uploaded");
      expect(stdout).toContain("foo.txt");
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("honors --path to override the workspace-relative location", async () => {
    const file = await makeLocalFile("foo.txt", "hello");
    try {
      const { calls } = scriptFetch([{ status: 200, body: UPLOAD_RESPONSE }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      await runWorkspaceUpload({
        apiUrl: "http://kanban.example.com",
        file,
        remotePath: "src/foo.txt",
        http,
      });
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.path).toBe("src/foo.txt");
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("emits JSON when format=json", async () => {
    const file = await makeLocalFile("foo.txt", "hi");
    try {
      scriptFetch([{ status: 200, body: { path: "foo.txt", size: 2 } }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const cap = makeCapture();
      await runWorkspaceUpload({
        apiUrl: "http://kanban.example.com",
        file,
        format: "json",
        http,
        io: cap.io,
      });
      const { stdout } = cap.read();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.apiUrl).toBe("http://kanban.example.com");
      expect(parsed.path).toBe("foo.txt");
      expect(parsed.size).toBe(2);
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("throws InvalidUsageError when the local file does not exist on disk", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runWorkspaceUpload({
        apiUrl: "http://kanban.example.com",
        file: "/this/path/should/never/exist/foo.txt",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("throws InvalidUsageError when the file argument is empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runWorkspaceUpload({
        apiUrl: "http://kanban.example.com",
        file: "   ",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps AuthError to NotLoggedInError and writes a hint to stderr", async () => {
    const file = await makeLocalFile("foo.txt", "hi");
    try {
      scriptFetch([{ status: 401, body: { error: "Not logged in" } }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const cap = makeCapture();
      await expect(
        runWorkspaceUpload({
          apiUrl: "http://kanban.example.com",
          file,
          http,
          io: cap.io,
        })
      ).rejects.toBeInstanceOf(NotLoggedInError);
      const { stderr } = cap.read();
      expect(stderr).toMatch(/Not logged in/);
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("runWorkspaceBatchUpload", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { files: [{ path, content }] } to /api/v1/workspace/batch-upload", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanban-ws-"));
    try {
      const file1 = path.join(dir, "foo.txt");
      const file2 = path.join(dir, "bar.txt");
      await writeFile(file1, "hello world", "utf8");
      await writeFile(file2, "goodbye", "utf8");
      const { calls } = scriptFetch([{ status: 200, body: BATCH_RESPONSE }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const cap = makeCapture();
      const report = await runWorkspaceBatchUpload({
        apiUrl: "http://kanban.example.com",
        files: [file1, file2],
        http,
        io: cap.io,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "http://kanban.example.com/api/v1/workspace/batch-upload"
      );
      expect(calls[0].init?.method).toBe("POST");
      const body = JSON.parse(String(calls[0].init?.body));
      expect(Array.isArray(body.files)).toBe(true);
      expect(body.files).toHaveLength(2);
      expect(body.files[0]).toMatchObject({ path: "foo.txt" });
      expect(body.files[1]).toMatchObject({ path: "bar.txt" });
      expect(report.summary.succeeded).toBe(2);
      expect(report.summary.failed).toBe(0);
      const { stdout } = cap.read();
      expect(stdout).toContain("Workspace");
      expect(stdout).toContain("2 ok / 0 failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces per-file errors returned by the server", async () => {
    const file1 = await makeLocalFile("foo.txt", "hi");
    const file2 = await makeLocalFile("bar.txt", "ho");
    try {
      scriptFetch([
        {
          status: 200,
          body: {
            "foo.txt": { path: "foo.txt", size: 2 },
            "bar.txt": { error: "Invalid path: cannot use '..'" },
          },
        },
      ]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const report = await runWorkspaceBatchUpload({
        apiUrl: "http://kanban.example.com",
        files: [file1, file2],
        http,
      });
      expect(report.summary.succeeded).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.results["foo.txt"]).toMatchObject({ path: "foo.txt" });
      expect(report.results["bar.txt"]).toEqual({
        error: "Invalid path: cannot use '..'",
      });
    } finally {
      await rm(path.dirname(file1), { recursive: true, force: true });
      await rm(path.dirname(file2), { recursive: true, force: true });
    }
  });

  it("throws InvalidUsageError when no files are supplied", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runWorkspaceBatchUpload({
        apiUrl: "http://kanban.example.com",
        files: [],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("emits JSON when format=json", async () => {
    const file = await makeLocalFile("foo.txt", "hi");
    try {
      scriptFetch([{ status: 200, body: BATCH_RESPONSE }]);
      const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
      const cap = makeCapture();
      await runWorkspaceBatchUpload({
        apiUrl: "http://kanban.example.com",
        files: [file],
        format: "json",
        http,
        io: cap.io,
      });
      const { stdout } = cap.read();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.summary).toEqual({ succeeded: 2, failed: 0 });
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("runWorkspaceList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs /api/v1/workspace/files and renders the entries", async () => {
    const { calls } = scriptFetch([{ status: 200, body: FILES_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runWorkspaceList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/workspace/files");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.files).toHaveLength(2);
    expect(report.files[0].name).toBe("foo.txt");
    const { stdout } = cap.read();
    expect(stdout).toContain("Workspace");
    expect(stdout).toContain("foo.txt");
    expect(stdout).toContain("nested");
  });

  it("forwards --path as a query string", async () => {
    const { calls } = scriptFetch([{ status: 200, body: { files: [] } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runWorkspaceList({
      apiUrl: "http://kanban.example.com",
      path: "src",
      http,
    });
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/workspace/files?path=src"
    );
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: FILES_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runWorkspaceList({
      apiUrl: "http://kanban.example.com",
      format: "json",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.files).toHaveLength(2);
    expect(report.files).toHaveLength(2);
  });

  it("renders an empty list gracefully", async () => {
    scriptFetch([{ status: 200, body: { files: [] } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runWorkspaceList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.files).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Workspace");
    expect(stdout).toContain("no files");
  });

  it("tolerates a missing `files` key in the server response", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runWorkspaceList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.files).toEqual([]);
  });
});

describe("runWorkspaceRead", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the raw file content to stdout in text mode", async () => {
    const { calls } = scriptFetch([{ status: 200, body: READ_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runWorkspaceRead(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "foo.txt"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/workspace/files/foo.txt"
    );
    expect(calls[0].init?.method).toBe("GET");
    const { stdout } = cap.read();
    expect(stdout).toBe("hello world\n");
    expect(result).toMatchObject({
      path: "foo.txt",
      content: "hello world",
      size: 11,
    });
  });

  it("emits a base64-encoded content payload in json mode", async () => {
    scriptFetch([{ status: 200, body: READ_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runWorkspaceRead(
      {
        apiUrl: "http://kanban.example.com",
        format: "json",
        http,
        io: cap.io,
      },
      "foo.txt"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.path).toBe("foo.txt");
    expect(parsed.encoding).toBe("base64");
    expect(parsed.size).toBe(11);
    expect(parsed.content).toBe(Buffer.from("hello world", "utf8").toString("base64"));
    expect(Buffer.from(parsed.content, "base64").toString("utf8")).toBe(
      "hello world"
    );
    expect(result).toMatchObject({ encoding: "base64" });
  });

  it("encodes the URL id so paths with spaces survive", async () => {
    const { calls } = scriptFetch([{ status: 200, body: READ_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runWorkspaceRead(
      { apiUrl: "http://kanban.example.com", http },
      "src/foo bar.txt"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/workspace/files/src%2Ffoo%20bar.txt"
    );
  });

  it("throws InvalidUsageError when id is empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runWorkspaceRead({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runWorkspaceRead({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("writes a 404 hint to stderr and propagates the error", async () => {
    scriptFetch([{ status: 404, body: { error: "File not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runWorkspaceRead(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost.txt"
      )
    ).rejects.toThrow(/404/);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/file not found/);
  });

  it("tolerates a missing content field and returns empty text", async () => {
    scriptFetch([{ status: 200, body: { size: 0 } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runWorkspaceRead(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "empty.txt"
    );
    const { stdout } = cap.read();
    expect(stdout).toBe("\n");
  });
});

describe("runWorkspaceDelete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs /api/v1/workspace/files/<id> and prints a confirmation", async () => {
    const { calls } = scriptFetch([{ status: 200, body: {} }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const result = await runWorkspaceDelete(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "foo.txt"
    );
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/workspace/files/foo.txt"
    );
    expect(calls[0].init?.method).toBe("DELETE");
    expect(result).toEqual({
      apiUrl: "http://kanban.example.com",
      path: "foo.txt",
      success: true,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Deleted");
    expect(stdout).toContain("foo.txt");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runWorkspaceDelete(
      {
        apiUrl: "http://kanban.example.com",
        format: "json",
        http,
        io: cap.io,
      },
      "foo.txt"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({
      apiUrl: "http://kanban.example.com",
      path: "foo.txt",
      success: true,
    });
  });

  it("throws InvalidUsageError when id is empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runWorkspaceDelete({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 and writes a hint to stderr", async () => {
    scriptFetch([{ status: 404, body: { error: "File not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runWorkspaceDelete(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost.txt"
      )
    ).rejects.toThrow(/404/);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/file not found/);
  });
});

describe("runWorkspaceStats", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs /api/v1/workspace/stats and renders the counters", async () => {
    const { calls } = scriptFetch([{ status: 200, body: STATS_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runWorkspaceStats({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/workspace/stats"
    );
    expect(calls[0].init?.method).toBe("GET");
    expect(report.stats).toEqual(STATS_RESPONSE);
    const { stdout } = cap.read();
    expect(stdout).toContain("Workspace");
    expect(stdout).toContain("totalFiles");
    expect(stdout).toContain("1234");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: STATS_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runWorkspaceStats({
      apiUrl: "http://kanban.example.com",
      format: "json",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.stats).toEqual(STATS_RESPONSE);
  });

  it("coerces missing counters to 0", async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runWorkspaceStats({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.stats).toEqual({
      totalFiles: 0,
      totalSize: 0,
      fileCount: 0,
      directoryCount: 0,
    });
  });
});
