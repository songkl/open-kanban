// Tests for `kanban tasks list / get / create / update / delete /
// complete / move`.
//
// The HttpClient is exercised through vi.spyOn(globalThis, "fetch") so
// the assertions cover both the request shape (URL, method, body, query
// string) and the output formatting (table vs. json). The list command
// hits the public columns endpoint; create / update / delete / complete
// are auth-required and call the RequireAuth-gated /api/v1/tasks*
// endpoints, so the auth-required scenarios use a bearer-token HttpClient
// (see makeAuthedClient).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../auth/client.js";
import type { OAuthMetadata } from "../auth/types.js";
import {
  runTasksList,
  runTaskGet,
  runTaskCreate,
  runTaskUpdate,
  runTaskDelete,
  runTaskComplete,
  runTaskMove,
  parseMetaArgs,
} from "./tasks.js";
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

const COLUMNS_PAYLOAD = [
  {
    id: "col-todo",
    name: "待办",
    status: "todo",
    position: 0,
    boardId: "b1",
    tasks: [
      {
        id: "t1",
        title: "Write spec",
        description: "spec for the CLI",
        priority: "high",
        assignee: "alice",
        columnId: "col-todo",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        meta: JSON.stringify({ tag: "spec" }),
      },
      {
        id: "t2",
        title: "Refactor auth",
        description: null,
        priority: "low",
        assignee: "bob",
        columnId: "col-todo",
        createdAt: "2025-12-30T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        meta: null,
      },
    ],
  },
  {
    id: "col-doing",
    name: "进行中",
    status: "in_progress",
    position: 1,
    boardId: "b1",
    tasks: [
      {
        id: "t3",
        title: "Implement tasks CLI",
        description: "list/get/create/etc",
        priority: "medium",
        assignee: "alice",
        columnId: "col-doing",
        createdAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
        meta: JSON.stringify({ tag: "feature" }),
      },
    ],
  },
  {
    id: "col-done",
    name: "已完成",
    status: "done",
    position: 2,
    boardId: "b1",
    tasks: [],
  },
];

const COLUMNS_OTHER_BOARD = [
  {
    id: "col-other-todo",
    name: "待办",
    status: "todo",
    position: 0,
    boardId: "b2",
    tasks: [
      {
        id: "t-other",
        title: "Other board task",
        priority: "low",
        assignee: "carol",
        columnId: "col-other-todo",
        createdAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      },
    ],
  },
];

const SINGLE_TASK_PAYLOAD = {
  id: "t1",
  title: "Write spec",
  description: "spec for the CLI",
  priority: "high",
  assignee: "alice",
  columnId: "col-todo",
  position: 0,
  published: true,
  archived: false,
  archivedAt: null,
  createdBy: "u1",
  createdByUsername: "alice",
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
  commentCount: 2,
  subtaskCount: 1,
};

describe("runTasksList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/columns with no filter by default", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/columns");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.tasks).toHaveLength(3);
  });

  it("forwards --board as a query param to the columns endpoint", async () => {
    const { calls } = scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/columns");
    expect(url.searchParams.get("boardId")).toBe("b1");
  });

  it("filters by --column id when supplied", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      columnId: "col-todo",
    });
    expect(report.tasks).toHaveLength(2);
    expect(report.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(report.columnId).toBe("col-todo");
  });

  it("resolves --status to a column name and filters tasks accordingly", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      status: "in_progress",
    });
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].id).toBe("t3");
    expect(report.status).toBe("in_progress");
  });

  it("rejects simultaneous --column and --status", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTasksList({
        apiUrl: "http://kanban.example.com",
        http,
        columnId: "col-todo",
        status: "todo",
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an unknown --status value", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTasksList({
        apiUrl: "http://kanban.example.com",
        http,
        // @ts-expect-error invalid status intentionally for the test
        status: "bogus",
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an unknown --priority value", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTasksList({
        apiUrl: "http://kanban.example.com",
        http,
        // @ts-expect-error invalid priority intentionally for the test
        priority: "urgent",
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an unknown --since value", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTasksList({
        apiUrl: "http://kanban.example.com",
        http,
        // @ts-expect-error invalid range intentionally for the test
        since: "yesterday",
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("filters by --priority / --assignee / --search / --tag", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });

    const byPriority = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      priority: "high",
    });
    expect(byPriority.tasks).toHaveLength(1);
    expect(byPriority.tasks[0].id).toBe("t1");

    const byAssignee = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      assignee: "bob",
    });
    expect(byAssignee.tasks).toHaveLength(1);
    expect(byAssignee.tasks[0].id).toBe("t2");

    const bySearch = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      search: "CLI",
    });
    // Both t1 (description "spec for the CLI") and t3 (title "Implement
    // tasks CLI") match the substring, so the result has 2 tasks.
    expect(bySearch.tasks.map((t) => t.id).sort()).toEqual(["t1", "t3"]);

    const byTag = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      tag: "spec",
    });
    expect(byTag.tasks).toHaveLength(1);
    expect(byTag.tasks[0].id).toBe("t1");
  });

  it("applies --since today|thisWeek|thisMonth filters", async () => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const columns = [
      {
        id: "col-todo",
        name: "待办",
        status: "todo",
        position: 0,
        boardId: "b1",
        tasks: [
          {
            id: "t-old",
            title: "old",
            priority: "low",
            assignee: "alice",
            columnId: "col-todo",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            id: "t-today",
            title: "fresh",
            priority: "high",
            assignee: "alice",
            columnId: "col-todo",
            createdAt: iso(now),
          },
        ],
      },
    ];
    scriptFetch([{ status: 200, body: columns }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });

    const today = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      since: "today",
    });
    expect(today.tasks.map((t) => t.id).sort()).toEqual(["t-today"]);

    const week = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      since: "thisWeek",
    });
    expect(week.tasks.map((t) => t.id).sort()).toEqual(["t-today"]);

    const month = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      since: "thisMonth",
    });
    expect(month.tasks.map((t) => t.id).sort()).toEqual(["t-today"]);
  });

  it("applies --agent-type against each column's agentConfig.agentTypes", async () => {
    const columns = [
      {
        id: "col-feature",
        name: "进行中",
        status: "in_progress",
        boardId: "b1",
        agentConfig: { agentTypes: ["code-review"] },
        tasks: [
          {
            id: "t-feature",
            title: "x",
            columnId: "col-feature",
            priority: "medium",
            assignee: null,
            createdAt: "2026-01-04T00:00:00Z",
          },
        ],
      },
      {
        id: "col-other",
        name: "待办",
        status: "todo",
        boardId: "b1",
        agentConfig: { agentTypes: ["writer"] },
        tasks: [
          {
            id: "t-other",
            title: "y",
            columnId: "col-other",
            priority: "medium",
            assignee: null,
            createdAt: "2026-01-04T00:00:00Z",
          },
        ],
      },
    ];
    scriptFetch([{ status: 200, body: columns }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      agentType: "code-review",
    });
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].id).toBe("t-feature");
  });

  it("projects --fields=id and --fields=id+updated", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });

    const idOnly = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: "id",
    });
    expect(Object.keys(idOnly.tasks[0]).sort()).toEqual(["id"]);

    const idUpdated = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      fields: "id+updated",
    });
    expect(Object.keys(idUpdated.tasks[0]).sort()).toEqual(["id", "updatedAt"]);
  });

  it("renders the default lightweight projection by default", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(Object.keys(report.tasks[0]).sort()).toEqual([
      "assignee",
      "createdAt",
      "id",
      "priority",
      "title",
    ]);
    const { stdout } = cap.read();
    expect(stdout).toContain("Tasks");
    expect(stdout).toContain("http://kanban.example.com");
    expect(stdout).toContain("t1");
    expect(stdout).toContain("Write spec");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      status: "in_progress",
      format: "json",
      io: cap.io,
    });
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.status).toBe("in_progress");
    expect(parsed.tasks).toHaveLength(1);
    expect(report.status).toBe("in_progress");
  });

  it("handles an empty task list gracefully", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(report.tasks).toEqual([]);
    const { stdout } = cap.read();
    expect(stdout).toContain("no tasks");
  });

  it("falls back to other boards when --status has no matching column in --board", async () => {
    scriptFetch([{ status: 200, body: COLUMNS_OTHER_BOARD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
      status: "todo",
    });
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].id).toBe("t-other");
  });

  it("returns no tasks when --board has no columns and no --status override", async () => {
    scriptFetch([{ status: 200, body: [] }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTasksList({
      apiUrl: "http://kanban.example.com",
      http,
      boardId: "b1",
    });
    expect(report.tasks).toEqual([]);
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTasksList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toThrow(/network|ETIMEDOUT/i);
  });
});

describe("runTaskGet", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes GET /api/v1/tasks/:id with the supplied id", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runTaskGet(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/t1");
    expect(calls[0].init?.method).toBe("GET");
    expect(report.task.id).toBe("t1");
  });

  it("renders full task details as a table", async () => {
    scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runTaskGet(
      { apiUrl: "http://kanban.example.com", http, io: cap.io },
      "t1"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Task");
    expect(stdout).toContain("t1");
    expect(stdout).toContain("Write spec");
    expect(stdout).toContain("alice");
    expect(stdout).toContain("col-todo");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runTaskGet(
      { apiUrl: "http://kanban.example.com", http, format: "json", io: cap.io },
      "t1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.task.id).toBe("t1");
  });

  it("encodes ids with special characters", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runTaskGet({ apiUrl: "http://kanban.example.com", http }, "a/b c");
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/a%2Fb%20c"
    );
  });

  it("throws InvalidUsageError when id is missing or empty", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runTaskGet({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(
      runTaskGet({ apiUrl: "http://kanban.example.com", http }, "   ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 as NotFoundError and writes a hint to stderr", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await expect(
      runTaskGet({ apiUrl: "http://kanban.example.com", http, io: cap.io }, "ghost")
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/task not found/i);
  });

  it("does not require auth (the endpoint is public)", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runTaskGet({ apiUrl: "http://kanban.example.com", http }, "t1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("runTaskCreate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves --column and POSTs the task body with a bearer token", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    const report = await runTaskCreate({
      apiUrl: "http://kanban.example.com",
      title: "Write spec",
      columnId: "col-todo",
      priority: "high",
      assignee: "alice",
      description: "spec for the CLI",
      meta: { tag: "spec" },
      http,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/columns");
    expect(calls[1].url).toBe("http://kanban.example.com/api/v1/tasks");
    expect(calls[1].init?.method).toBe("POST");
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.title).toBe("Write spec");
    expect(body.columnId).toBe("col-todo");
    expect(body.priority).toBe("high");
    expect(body.assignee).toBe("alice");
    expect(body.description).toBe("spec for the CLI");
    expect(body.meta).toEqual({ tag: "spec" });
    expect(body.published).toBe(true);
    expect(report.task.id).toBe("t1");
  });

  it("defaults --priority to medium and --published to true", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskCreate({
      apiUrl: "http://kanban.example.com",
      title: "x",
      columnId: "col-todo",
      http,
    });
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.priority).toBe("medium");
    expect(body.published).toBe(true);
  });

  it("resolves --status to a column name within --board", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskCreate({
      apiUrl: "http://kanban.example.com",
      title: "x",
      status: "in_progress",
      boardId: "b1",
      http,
    });
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.columnId).toBe("col-doing");
  });

  it("falls back to the first column when no column / status is supplied", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskCreate({
      apiUrl: "http://kanban.example.com",
      title: "x",
      http,
    });
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.columnId).toBe("col-todo");
  });

  it("rejects simultaneous --column and --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskCreate({
        apiUrl: "http://kanban.example.com",
        title: "x",
        columnId: "col-todo",
        status: "todo",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("requires --title", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskCreate({
        apiUrl: "http://kanban.example.com",
        title: "",
        columnId: "col-todo",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid --priority value", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskCreate({
        apiUrl: "http://kanban.example.com",
        title: "x",
        columnId: "col-todo",
        // @ts-expect-error invalid priority intentionally for the test
        priority: "urgent",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects an invalid --status value", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskCreate({
        apiUrl: "http://kanban.example.com",
        title: "x",
        // @ts-expect-error invalid status intentionally for the test
        status: "bogus",
        http,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps a 401 response to NotLoggedInError", async () => {
    scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 401, body: { error: "unauthorized" } },
    ]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTaskCreate({
        apiUrl: "http://kanban.example.com",
        title: "x",
        columnId: "col-todo",
        http,
        io: cap.io,
      })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Not logged in/i);
  });
});

describe("runTaskUpdate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs the supplied fields to /api/v1/tasks/:id with a bearer token", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    const report = await runTaskUpdate(
      {
        apiUrl: "http://kanban.example.com",
        title: "Updated",
        priority: "low",
        columnId: "col-doing",
        http,
      },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/t1");
    expect(calls[0].init?.method).toBe("PUT");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.title).toBe("Updated");
    expect(body.priority).toBe("low");
    expect(body.columnId).toBe("col-doing");
    expect(report.task.id).toBe("t1");
  });

  it("resolves --status to a columnId via the columns endpoint", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskUpdate(
      { apiUrl: "http://kanban.example.com", status: "done", http },
      "t1"
    );
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.columnId).toBe("col-done");
  });

  it("rejects an empty body (no updatable fields supplied)", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskUpdate({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("requires a task id", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskUpdate({ apiUrl: "http://kanban.example.com", title: "x", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects simultaneous --column and --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskUpdate(
        {
          apiUrl: "http://kanban.example.com",
          columnId: "col-todo",
          status: "todo",
          http,
        },
        "t1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTaskUpdate(
        { apiUrl: "http://kanban.example.com", title: "x", http, io: cap.io },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/task not found/i);
  });
});

describe("runTaskDelete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs /api/v1/tasks/:id with a bearer token", async () => {
    const { calls } = scriptFetch([{ status: 200, body: { success: true } }]);
    const http = makeAuthedClient();
    const result = await runTaskDelete(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.example.com/api/v1/tasks/t1");
    expect(calls[0].init?.method).toBe("DELETE");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(result.success).toBe(true);
    expect(result.id).toBe("t1");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: { success: true } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await runTaskDelete(
      { apiUrl: "http://kanban.example.com", http, format: "json", io: cap.io },
      "t1"
    );
    const { stdout } = cap.read();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe("t1");
  });

  it("requires a task id", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskDelete({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("propagates 404 with a stderr hint", async () => {
    scriptFetch([{ status: 404, body: { error: "Task not found" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTaskDelete(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "ghost"
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/task not found/i);
  });
});

describe("runTaskComplete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/v1/tasks/:id/complete with a bearer token", async () => {
    const { calls } = scriptFetch([{ status: 200, body: SINGLE_TASK_PAYLOAD }]);
    const http = makeAuthedClient();
    const report = await runTaskComplete(
      { apiUrl: "http://kanban.example.com", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://kanban.example.com/api/v1/tasks/t1/complete"
    );
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(report.task.id).toBe("t1");
  });

  it("requires a task id", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskComplete({ apiUrl: "http://kanban.example.com", http }, "")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("maps a 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const http = makeAuthedClient();
    const cap = makeCapture();
    await expect(
      runTaskComplete(
        { apiUrl: "http://kanban.example.com", http, io: cap.io },
        "t1"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Not logged in/i);
  });
});

describe("runTaskMove", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves --status to a columnId and PUTs the task", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskMove(
      { apiUrl: "http://kanban.example.com", status: "done", http },
      "t1"
    );
    expect(calls).toHaveLength(2);
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.columnId).toBe("col-done");
  });

  it("accepts --column directly", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: SINGLE_TASK_PAYLOAD },
    ]);
    const http = makeAuthedClient();
    await runTaskMove(
      { apiUrl: "http://kanban.example.com", columnId: "col-done", http },
      "t1"
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.columnId).toBe("col-done");
  });

  it("rejects calls with neither --column nor --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskMove({ apiUrl: "http://kanban.example.com", http }, "t1")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects simultaneous --column and --status", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskMove(
        {
          apiUrl: "http://kanban.example.com",
          columnId: "col-done",
          status: "done",
          http,
        },
        "t1"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("requires a task id", async () => {
    const http = makeAuthedClient();
    await expect(
      runTaskMove(
        { apiUrl: "http://kanban.example.com", status: "done", http },
        ""
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });
});

describe("parseMetaArgs", () => {
  it("returns an empty object for missing input", () => {
    expect(parseMetaArgs(undefined)).toEqual({});
    expect(parseMetaArgs([])).toEqual({});
  });

  it("parses a single key=value pair", () => {
    expect(parseMetaArgs(["k=v"])).toEqual({ k: "v" });
  });

  it("parses comma-separated key=value pairs inside one argument", () => {
    expect(parseMetaArgs(["k1=v1,k2=v2"])).toEqual({ k1: "v1", k2: "v2" });
  });

  it("merges multiple --meta invocations", () => {
    expect(parseMetaArgs(["a=1", "b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("skips entries without an = separator", () => {
    expect(parseMetaArgs(["bogus", "k=v"])).toEqual({ k: "v" });
  });

  it("trims surrounding whitespace from keys and values", () => {
    expect(parseMetaArgs([" k = v "])).toEqual({ k: "v" });
  });

  it("lets later values overwrite earlier ones", () => {
    expect(parseMetaArgs(["k=1", "k=2"])).toEqual({ k: "2" });
  });
});

describe("AuthError → NotLoggedInError mapping", () => {
  it("preserves the AuthError class hierarchy", () => {
    const a = new AuthError("boom", { path: "/x" });
    const n = new NotLoggedInError("boom");
    expect(n).not.toBeInstanceOf(AuthError);
    expect(a).not.toBeInstanceOf(NotLoggedInError);
  });
});
