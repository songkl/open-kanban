// Tests for `kanban tasks batch create / update / delete`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so
// each scenario asserts the request shape (URL, method, body) and the
// rendered table / json output. The file-based input helpers
// (parseIdsFile, loadTasksFile, alignFlagTasks) are tested against a
// temporary file written into vitest's tmpdir via mkdtemp.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../auth/client.js";
import type { OAuthMetadata } from "../auth/types.js";
import {
  runTasksBatchCreate,
  runTasksBatchUpdate,
  runTasksBatchDelete,
  alignFlagTasks,
  loadTasksFile,
  parseIdsFile,
  splitFlagValues,
} from "./tasks_batch.js";
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

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "kanban-batch-"));
}

describe("splitFlagValues", () => {
  it("returns [] when undefined", () => {
    expect(splitFlagValues(undefined)).toEqual([]);
  });

  it("wraps a single string in an array", () => {
    expect(splitFlagValues("a")).toEqual(["a"]);
  });

  it("returns the existing array as-is", () => {
    expect(splitFlagValues(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("parseIdsFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });

  it("parses one id per line and skips blanks / comments", async () => {
    const path = join(dir, "ids.txt");
    writeFileSync(
      path,
      "# header\nt1\n\nt2\n  t3  \n# trailing\n",
      "utf8"
    );
    expect(await parseIdsFile(path)).toEqual(["t1", "t2", "t3"]);
  });

  it("handles CRLF line endings", async () => {
    const path = join(dir, "ids.txt");
    writeFileSync(path, "t1\r\nt2\r\n", "utf8");
    expect(await parseIdsFile(path)).toEqual(["t1", "t2"]);
  });
});

describe("loadTasksFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });

  it("loads a JSON array of task objects", async () => {
    const path = join(dir, "tasks.json");
    writeFileSync(
      path,
      JSON.stringify([
        { title: "a", columnId: "c1" },
        { title: "b", columnId: "c1", priority: "high" },
      ]),
      "utf8"
    );
    const out = await loadTasksFile(path);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("a");
    expect(out[1].priority).toBe("high");
  });

  it("loads a single JSON object as a one-element array", async () => {
    const path = join(dir, "task.json");
    writeFileSync(path, JSON.stringify({ title: "solo" }), "utf8");
    const out = await loadTasksFile(path);
    expect(out).toEqual([{ title: "solo" }]);
  });

  it("loads a YAML list of tasks", async () => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(
      path,
      `- title: a\n  columnId: c1\n- title: b\n  columnId: c1\n  status: in_progress\n`,
      "utf8"
    );
    const out = await loadTasksFile(path);
    expect(out.map((t) => t.title)).toEqual(["a", "b"]);
    expect(out[1].status).toBe("in_progress");
  });

  it("rejects an empty file", async () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "  \n", "utf8");
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an empty array", async () => {
    const path = join(dir, "empty-array.json");
    writeFileSync(path, "[]", "utf8");
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects a missing title", async () => {
    const path = join(dir, "no-title.json");
    writeFileSync(path, JSON.stringify([{ columnId: "c1" }]), "utf8");
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid priority", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify([{ title: "x", priority: "urgent" }]),
      "utf8"
    );
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid status", async () => {
    const path = join(dir, "bad-status.yaml");
    writeFileSync(
      path,
      "- title: x\n  status: blocked\n",
      "utf8"
    );
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects a non-object entry", async () => {
    const path = join(dir, "bad-entry.json");
    writeFileSync(path, JSON.stringify(["not-an-object"]), "utf8");
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects malformed JSON", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    await expect(loadTasksFile(path)).rejects.toBeInstanceOf(InvalidUsageError);
  });
});

describe("alignFlagTasks", () => {
  it("returns [] when no values are supplied", () => {
    expect(
      alignFlagTasks({
        titles: [],
        columns: [],
        descriptions: [],
        priorities: [],
        assignees: [],
        statuses: [],
        publisheds: [],
      })
    ).toEqual([]);
  });

  it("aligns parallel arrays positionally", () => {
    const out = alignFlagTasks({
      titles: ["a", "b"],
      columns: ["c1", "c2"],
      descriptions: ["d1"],
      priorities: [],
      assignees: ["alice", "bob"],
      statuses: [],
      publisheds: [],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: "a",
      columnId: "c1",
      description: "d1",
      assignee: "alice",
    });
    expect(out[1]).toMatchObject({
      title: "b",
      columnId: "c2",
      assignee: "bob",
    });
  });

  it("rejects an invalid priority", () => {
    expect(() =>
      alignFlagTasks({
        titles: ["a"],
        columns: ["c"],
        descriptions: [],
        priorities: ["urgent"],
        assignees: [],
        statuses: [],
        publisheds: [],
      })
    ).toThrow(InvalidUsageError);
  });

  it("rejects an invalid status", () => {
    expect(() =>
      alignFlagTasks({
        titles: ["a"],
        columns: ["c"],
        descriptions: [],
        priorities: [],
        assignees: [],
        statuses: ["blocked"],
        publisheds: [],
      })
    ).toThrow(InvalidUsageError);
  });

  it("rejects an empty title at any position", () => {
    expect(() =>
      alignFlagTasks({
        titles: ["a", "  "],
        columns: ["c1", "c2"],
        descriptions: [],
        priorities: [],
        assignees: [],
        statuses: [],
        publisheds: [],
      })
    ).toThrow(InvalidUsageError);
  });
});

describe("runTasksBatchCreate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { tasks } to /api/v1/tasks/batch with a bearer token", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: {
          created: 2,
          failed: 0,
          tasks: [
            { id: "t1", title: "a" },
            { id: "t2", title: "b" },
          ],
        },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runTasksBatchCreate({
      apiUrl: "http://kanban.example.com",
      tasks: [
        { title: "a", columnId: "c1", priority: "high" },
        { title: "b", columnId: "c1" },
      ],
      http,
      io: cap.io,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/batch");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]).toMatchObject({
      title: "a",
      columnId: "c1",
      priority: "high",
      published: true,
    });
    expect(body.tasks[1].priority).toBe("medium");
    expect(report.created).toBe(2);
    expect(report.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Batch create");
    expect(stdout).toContain("created: 2");
    expect(stdout).toContain("t1");
    expect(stdout).toContain("a");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([
      { status: 200, body: { created: 1, failed: 0, tasks: [{ id: "t1", title: "a" }] } },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runTasksBatchCreate({
      apiUrl: "http://kanban.example.com",
      tasks: [{ title: "a", columnId: "c1" }],
      format: "json",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.created).toBe(1);
    expect(parsed.tasks[0].id).toBe("t1");
  });

  it("renders server-side errors in the table", async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          created: 1,
          failed: 1,
          tasks: [{ id: "t1", title: "a" }],
          errors: ["task 0: validation failed"],
        },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runTasksBatchCreate({
      apiUrl: "http://kanban.example.com",
      tasks: [
        { title: "a", columnId: "c1" },
        { title: "b", columnId: "missing" },
      ],
      http,
      io: cap.io,
    });
    expect(report.failed).toBe(1);
    expect(report.errors).toEqual(["task 0: validation failed"]);
    const { stdout } = cap.read();
    expect(stdout).toContain("failed: 1");
    expect(stdout).toContain("validation failed");
  });

  it("rejects an empty spec list", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchCreate({
        apiUrl: "http://kanban.example.com",
        tasks: [],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects a spec with an empty title", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchCreate({
        apiUrl: "http://kanban.example.com",
        tasks: [{ title: "  " }],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid priority value", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchCreate({
        apiUrl: "http://kanban.example.com",
        tasks: [{ title: "a", priority: "urgent" as never }],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps a 401 response to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTasksBatchCreate({
        apiUrl: "http://kanban.example.com",
        tasks: [{ title: "a", columnId: "c1" }],
        http,
        io: cap.io,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Not logged in/i);
  });

  it("maps a 404 to NotFoundError with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "column not found" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTasksBatchCreate({
        apiUrl: "http://kanban.example.com",
        tasks: [{ title: "a", columnId: "missing" }],
        http,
        io: cap.io,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/column not found/i);
  });
});

describe("runTasksBatchUpdate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs { ids, columnId } to /api/v1/tasks/batch", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { updated: 2, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    const report = await runTasksBatchUpdate({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", "t2"],
      columnId: "c1",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/batch");
    expect(calls[0].init?.method).toBe("PUT");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ ids: ["t1", "t2"], columnId: "c1" });
    expect(report.updated).toBe(2);
    expect(report.failed).toBe(0);
  });

  it("forwards --status so the server can resolve a columnId", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { updated: 1, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    await runTasksBatchUpdate({
      apiUrl: "http://kanban.example.com",
      ids: ["t1"],
      status: "done",
      http,
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ ids: ["t1"], status: "done" });
  });

  it("forwards --priority and --assignee together", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { updated: 1, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    await runTasksBatchUpdate({
      apiUrl: "http://kanban.example.com",
      ids: ["t1"],
      priority: "high",
      assignee: "alice",
      http,
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      ids: ["t1"],
      priority: "high",
      assignee: "alice",
    });
  });

  it("deduplicates ids", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { updated: 2, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    await runTasksBatchUpdate({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", "t1", "t2", " "],
      columnId: "c1",
      http,
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.ids).toEqual(["t1", "t2"]);
  });

  it("rejects an empty ids list", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: [],
        columnId: "c1",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects simultaneous --column and --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        columnId: "c1",
        status: "todo",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects calls with no update fields", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid --priority", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        priority: "urgent",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        status: "blocked" as never,
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("renders server-side errors in the table", async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          updated: 1,
          failed: 1,
          errors: ["task t2: not found"],
        },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runTasksBatchUpdate({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", "t2"],
      priority: "high",
      http,
      io: cap.io,
    });
    expect(report.failed).toBe(1);
    expect(report.errors).toEqual(["task t2: not found"]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Batch update");
    expect(stdout).toContain("t2: not found");
  });

  it("maps a 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    await expect(
      runTasksBatchUpdate({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        columnId: "c1",
        http,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("runTasksBatchDelete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs { ids } to /api/v1/tasks/batch with a bearer token", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { deleted: 2, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    const report = await runTasksBatchDelete({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", "t2"],
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/batch");
    expect(calls[0].init?.method).toBe("DELETE");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ ids: ["t1", "t2"] });
    expect(report.deleted).toBe(2);
    expect(report.failed).toBe(0);
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([
      { status: 200, body: { deleted: 1, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runTasksBatchDelete({
      apiUrl: "http://kanban.example.com",
      ids: ["t1"],
      format: "json",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.deleted).toBe(1);
  });

  it("renders server-side errors in the table", async () => {
    scriptFetch([
      {
        status: 200,
        body: {
          deleted: 1,
          failed: 1,
          errors: ["task t2: no permission"],
        },
      },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    const report = await runTasksBatchDelete({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", "t2"],
      http,
      io: cap.io,
    });
    expect(report.failed).toBe(1);
    expect(report.errors).toEqual(["task t2: no permission"]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Batch delete");
    expect(stdout).toContain("no permission");
  });

  it("rejects an empty ids list", async () => {
    const http = makeAuthedClient();
    await expect(
      runTasksBatchDelete({
        apiUrl: "http://kanban.example.com",
        ids: [],
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("trims and deduplicates ids", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { deleted: 2, failed: 0 } },
    ]);
    const http = makeAuthedClient();
    await runTasksBatchDelete({
      apiUrl: "http://kanban.example.com",
      ids: ["t1", " t2 ", "t1"],
      http,
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.ids).toEqual(["t1", "t2"]);
  });

  it("maps a 404 to NotFoundError", async () => {
    scriptFetch([{ status: 404, body: { error: "column not found" } }]);
    const http = makeAuthedClient();
    await expect(
      runTasksBatchDelete({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        http,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps a 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    await expect(
      runTasksBatchDelete({
        apiUrl: "http://kanban.example.com",
        ids: ["t1"],
        http,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("AuthError → NotLoggedInError mapping", () => {
  it("preserves the class hierarchy", () => {
    const a = new AuthError("boom", { path: "/x" });
    const n = new NotLoggedInError("boom");
    expect(n).not.toBeInstanceOf(AuthError);
    expect(a).not.toBeInstanceOf(NotLoggedInError);
  });
});
