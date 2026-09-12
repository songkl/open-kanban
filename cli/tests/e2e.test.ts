// End-to-end integration tests for the Open Kanban CLI.
//
// These tests exercise the same call chain a user would run from a shell:
//
//    kanban auth login
//    kanban boards list
//    kanban tasks list
//    kanban tasks complete <id>
//
// `fetch` is mocked at the network boundary via vi.spyOn(globalThis, "fetch")
// and vi.useFakeTimers() advances the device-flow polling clock instantly so
// the test stays hermetic and deterministic. Each scenario scripts the
// expected request shape (URL, method, headers, body) and the canned
// response, then asserts the returned reports match what the user would see
// on stdout. The token store is backed by `InMemorySecretProvider` so the
// OAuth client and HttpClient can share credentials within one test.
//
// The scenario covered here is the "happy path": a fresh OAuth client
// registers with the server, runs the device flow to obtain an access
// token, lists boards, lists tasks, and finally advances a task through
// its column. All requests ride on the same OAuth bearer token that the
// device flow produced.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient } from "../src/http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../src/auth/client.js";
import type { OAuthMetadata } from "../src/auth/types.js";
import {
  runLogin,
  runStatus as runAuthStatus,
} from "../src/auth/commands.js";
import { runBoardsList } from "../src/commands/boards.js";
import { runTasksList, runTaskComplete } from "../src/commands/tasks.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeCapture(): {
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
  read: () => { stdout: string; stderr: string };
  reset: () => void;
} {
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

// scriptFetch installs a mock for `globalThis.fetch` that records every call
// and replays a fixed sequence of responses. The last response is reused if
// the caller asks for more replies than were scripted (defensive default so
// unexpected extra calls produce a recognisable payload rather than crashing
// the test).
function scriptFetch(responses: ScriptedResponse[]): {
  calls: FetchCall[];
  spy: ReturnType<typeof vi.fn>;
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return { calls, spy };
}

const API_URL = "http://kanban.example.com";

const METADATA: OAuthMetadata = {
  issuer: API_URL,
  authorization_endpoint: `${API_URL}/oauth/authorize`,
  token_endpoint: `${API_URL}/oauth/token`,
  jwks_uri: `${API_URL}/.well-known/jwks.json`,
  registration_endpoint: `${API_URL}/oauth/register`,
  device_authorization_endpoint: `${API_URL}/oauth/device/code`,
  grant_types_supported: [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

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
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-03T00:00:00Z",
    _count: { columns: 3 },
  },
];

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

const COMPLETED_TASK_PAYLOAD = {
  id: "t1",
  title: "Write spec",
  description: "spec for the CLI",
  priority: "high",
  assignee: "alice",
  columnId: "col-doing",
  position: 0,
  published: true,
  archived: false,
  archivedAt: null,
  createdBy: "u1",
  createdByUsername: "alice",
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-05T00:00:00Z",
  commentCount: 2,
  subtaskCount: 1,
};

describe("CLI end-to-end (auth login → boards list → tasks list → task complete)", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("walks a fresh device-flow login into a full task lifecycle", async () => {
    // vi.useFakeTimers advances the device-flow polling clock instantly, so
    // the authorizeInteractive poll loop runs as fast as the mock fetch can
    // resolve. The token is "approved" on the second poll, mirroring how a
    // real OAuth server behaves while the user is still on the browser.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Script the network calls in the exact order the CLI makes them:
    //
    //   1. POST /oauth/register          (DCR)
    //   2. POST /oauth/device/code       (device authorization request)
    //   3. POST /oauth/token             (first poll: authorization_pending)
    //   4. POST /oauth/token             (second poll: approved)
    //   5. GET  /api/v1/boards           (public boards list)
    //   6. GET  /api/v1/columns          (tasks list pulls columns once)
    //   7. POST /api/v1/tasks/t1/complete (advance to next column)
    const { calls } = scriptFetch([
      {
        status: 201,
        body: {
          client_id: "cid-cli-1",
          client_name: "open-kanban-cli",
          scope: "kanban:read tasks:write",
          token_endpoint_auth_method: "none",
        },
      },
      {
        status: 200,
        body: {
          device_code: "dev-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: `${API_URL}/oauth/device`,
          verification_uri_complete: `${API_URL}/oauth/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
          scope: "kanban:read tasks:write",
        },
      },
      {
        status: 400,
        body: { error: "authorization_pending" },
      },
      {
        status: 200,
        body: {
          access_token: "at-e2e-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt-e2e-1",
          scope: "kanban:read tasks:write",
        },
      },
      { status: 200, body: BOARDS_PAYLOAD },
      { status: 200, body: COLUMNS_PAYLOAD },
      { status: 200, body: COMPLETED_TASK_PAYLOAD },
    ]);

    // ---- Step 1: auth login (device flow) ----------------------------------
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient(API_URL, METADATA, provider);
    const capLogin = makeCapture();
    const loginResult = await oauth.authorizeInteractive({
      apiUrl: API_URL,
      clientName: "open-kanban-cli",
      appName: "kanban-cli",
      onPrompt: async (poll) => {
        // Simulate the user approving the device prompt in the browser.
        capLogin.io.stderr?.write(
          `visit ${poll.verificationUri} code ${poll.userCode}\n`
        );
        return "approve";
      },
    });
    expect(loginResult.access_token).toBe("at-e2e-1");

    // DCR hit the registration endpoint exactly once.
    expect(calls[0].url).toBe(`${API_URL}/oauth/register`);
    expect(calls[0].init?.method).toBe("POST");
    const registerBody = JSON.parse(calls[0].init?.body as string);
    expect(registerBody.client_name).toBe("open-kanban-cli");
    expect(registerBody.grant_types).toContain(
      "urn:ietf:params:oauth:grant-type:device_code"
    );

    // Device authorization request used the returned client_id.
    expect(calls[1].url).toBe(`${API_URL}/oauth/device/code`);
    expect(calls[1].init?.method).toBe("POST");
    const deviceBody = new URLSearchParams(calls[1].init?.body as string);
    expect(deviceBody.get("client_id")).toBe("cid-cli-1");

    // Polling loop sent two token requests (pending then approved).
    const tokenCalls = calls.filter((c) => c.url === `${API_URL}/oauth/token`);
    expect(tokenCalls).toHaveLength(2);
    for (const tc of tokenCalls) {
      const params = new URLSearchParams(tc.init?.body as string);
      expect(params.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code"
      );
      expect(params.get("client_id")).toBe("cid-cli-1");
      expect(params.get("device_code")).toBe("dev-code-1");
    }

    // The CLI printed the verification URL + user code so the human could
    // approve the device flow on a browser.
    const { stderr: loginStderr } = capLogin.read();
    expect(loginStderr).toContain("ABCD-EFGH");
    expect(loginStderr).toContain(`${API_URL}/oauth/device`);

    // The InMemorySecretProvider persisted the issued access token.
    const stored = provider.read();
    expect(stored?.accessToken).toBe("at-e2e-1");
    expect(stored?.refreshToken).toBe("rt-e2e-1");
    expect(stored?.clientId).toBe("cid-cli-1");

    // ---- Step 2: attach the OAuth client to an HttpClient -----------------
    // This is exactly what the CLI bootstrap does in index.ts when wiring
    // `auth login` → `tasks list`. After this point the HttpClient will
    // automatically send the bearer token on every request.
    const http = new HttpClient({ apiUrl: API_URL });
    http.attachOAuth(oauth);

    // ---- Step 3: kanban boards list ---------------------------------------
    // The endpoint is public so it works without authentication, but the
    // attached OAuth client still rides on the request.
    const capBoards = makeCapture();
    const boardsReport = await runBoardsList({
      apiUrl: API_URL,
      http,
      format: "json",
      io: capBoards.io,
    });
    expect(boardsReport.boards).toHaveLength(2);
    expect(boardsReport.boards[0].id).toBe("b1");
    expect(boardsReport.boards[1].id).toBe("b2");
    expect(calls[4].url).toBe(`${API_URL}/api/v1/boards`);
    expect(calls[4].init?.method).toBe("GET");

    // ---- Step 4: kanban tasks list ----------------------------------------
    // The CLI pulls columns once and filters client-side. The bearer token
    // is attached automatically via HttpClient.
    const capTasks = makeCapture();
    const tasksReport = await runTasksList({
      apiUrl: API_URL,
      http,
      format: "json",
      io: capTasks.io,
    });
    expect(tasksReport.tasks).toHaveLength(3);
    const tasksHeaders = calls[5].init?.headers as Record<string, string>;
    expect(tasksHeaders.Authorization).toBe("Bearer at-e2e-1");
    expect(tasksHeaders.Accept).toBe("application/json");
    expect(calls[5].url).toBe(`${API_URL}/api/v1/columns`);

    // ---- Step 5: kanban tasks complete <id> -------------------------------
    // This is the auth-required POST /api/v1/tasks/:id/complete endpoint.
    const capComplete = makeCapture();
    const completedReport = await runTaskComplete(
      { apiUrl: API_URL, http, format: "json", io: capComplete.io },
      "t1"
    );
    expect(completedReport.task.id).toBe("t1");
    expect(completedReport.task.columnId).toBe("col-doing");
    expect(calls[6].url).toBe(`${API_URL}/api/v1/tasks/t1/complete`);
    expect(calls[6].init?.method).toBe("POST");
    const completeHeaders = calls[6].init?.headers as Record<string, string>;
    expect(completeHeaders.Authorization).toBe("Bearer at-e2e-1");

    // Sanity: the cumulative call count matches the seven scripted responses
    // (DCR + device + 2 polls + boards + columns + complete).
    expect(calls.map((c) => c.url)).toEqual([
      `${API_URL}/oauth/register`,
      `${API_URL}/oauth/device/code`,
      `${API_URL}/oauth/token`,
      `${API_URL}/oauth/token`,
      `${API_URL}/api/v1/boards`,
      `${API_URL}/api/v1/columns`,
      `${API_URL}/api/v1/tasks/t1/complete`,
    ]);
  });

  it("survives a denial during the device flow without persisting credentials", async () => {
    // When the user clicks "Deny" in the browser, the token endpoint returns
    // access_denied. authorizeInteractive should propagate the error and
    // NOT store an access token. A subsequent `boards list` still works
    // because the boards endpoint is public.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scriptFetch([
      {
        status: 201,
        body: { client_id: "cid-cli-2", client_name: "open-kanban-cli" },
      },
      {
        status: 200,
        body: {
          device_code: "dev-code-2",
          user_code: "WXYZ-1234",
          verification_uri: `${API_URL}/oauth/device`,
          expires_in: 600,
          interval: 1,
        },
      },
      {
        status: 400,
        body: { error: "access_denied", error_description: "user said no" },
      },
    ]);

    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient(API_URL, METADATA, provider);
    await expect(
      oauth.authorizeInteractive({
        apiUrl: API_URL,
        clientName: "open-kanban-cli",
        appName: "kanban-cli",
        onPrompt: async () => "approve",
      })
    ).rejects.toThrow(/denied/i);

    // No access token should have been persisted: the provider still has
    // only the client_id that ensureRegistered wrote.
    const stored = provider.read();
    expect(stored).not.toBeNull();
    expect(stored?.clientId).toBe("cid-cli-2");
    expect(stored?.accessToken).toBeUndefined();
  });

  it(
    "walks the full Phase 1 user journey via the CLI command wrappers",
    async () => {
      // The two scenarios above reach into OAuthClient directly so they
      // can pin the device-flow protocol wire format. This scenario
      // exercises the SAME flow through the command wrappers a real
      // user hits when typing `kanban auth login` / `kanban auth status`
      // / `kanban boards list` / `kanban tasks list` / `kanban tasks
      // complete <id>` at a shell. The intent is to catch regressions
      // where the command surface drifts away from the underlying
      // OAuth/HTTP primitives (e.g. a new flag that drops the bearer
      // token, or a wrapper that swallows an error).
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const { calls } = scriptFetch([
        // runLogin → authorizeInteractive → ensureRegistered
        {
          status: 201,
          body: {
            client_id: "cid-cli-journey",
            client_name: "open-kanban-cli",
            scope: "kanban:read tasks:write",
            token_endpoint_auth_method: "none",
          },
        },
        // runLogin → authorizeInteractive → requestDeviceCode
        {
          status: 200,
          body: {
            device_code: "dev-code-journey",
            user_code: "JOUR-NEY1",
            verification_uri: `${API_URL}/oauth/device`,
            verification_uri_complete: `${API_URL}/oauth/device?code=JOUR-NEY1`,
            expires_in: 600,
            interval: 1,
            scope: "kanban:read tasks:write",
          },
        },
        // First poll: pending
        {
          status: 400,
          body: { error: "authorization_pending" },
        },
        // Second poll: approved
        {
          status: 200,
          body: {
            access_token: "at-journey-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-journey-1",
            scope: "kanban:read tasks:write",
          },
        },
        // runAuthStatus → loadCredentials (no network call) — but the
        // HttpClient is wired, so we still emit a placeholder; the
        // status command does not actually need it. Keeping the slot
        // for the boards list call that follows.
        // boards list
        { status: 200, body: BOARDS_PAYLOAD },
        // tasks list
        { status: 200, body: COLUMNS_PAYLOAD },
        // task complete
        { status: 200, body: COMPLETED_TASK_PAYLOAD },
      ]);

      // ---- Step 1: kanban auth login (runLogin wrapper) -----------------
      // This is the exact code path the `auth login` Commander action
      // handler invokes. The wrapper prints the verification URL +
      // user code to stderr (so a terminal captures them) and writes
      // the "Logged in to ..." line to stdout.
      const provider = new InMemorySecretProvider();
      const oauth = new OAuthClient(API_URL, METADATA, provider);
      const capLogin = makeCapture();
      const loginResult = await runLogin(
        { apiUrl: API_URL, profile: "default" },
        { oauth, io: capLogin.io }
      );
      expect(loginResult.credentials?.accessToken).toBe("at-journey-1");
      const { stdout: loginStdout, stderr: loginStderr } = capLogin.read();
      expect(loginStdout).toMatch(/Logged in to/);
      expect(loginStdout).toContain("cid-cli-journey");
      expect(loginStderr).toContain("JOUR-NEY1");
      expect(loginStderr).toContain(`${API_URL}/oauth/device`);

      // ---- Step 2: kanban auth status (runAuthStatus wrapper) -----------
      // Reads credentials from the in-memory store and prints the
      // formatted status report to stdout. No HTTP calls.
      const capStatus = makeCapture();
      const statusReport = await runAuthStatus(
        { apiUrl: API_URL, profile: "default" },
        { oauth, io: capStatus.io }
      );
      expect(statusReport.clientId).toBe("cid-cli-journey");
      expect(statusReport.scope).toBe("kanban:read tasks:write");
      expect(statusReport.hasRefreshToken).toBe(true);
      expect(statusReport.accessTokenRemainingSeconds).toBeGreaterThan(0);
      const { stdout: statusStdout } = capStatus.read();
      expect(statusStdout).toContain("cid-cli-journey");
      expect(statusStdout).toContain("kanban:read tasks:write");

      // ---- Step 3: attach OAuth + run boards list / tasks list / complete
      const http = new HttpClient({ apiUrl: API_URL });
      http.attachOAuth(oauth);

      const capBoards = makeCapture();
      const boardsReport = await runBoardsList({
        apiUrl: API_URL,
        http,
        format: "json",
        io: capBoards.io,
      });
      expect(boardsReport.boards.map((b) => b.id)).toEqual(["b1", "b2"]);

      const capTasks = makeCapture();
      const tasksReport = await runTasksList({
        apiUrl: API_URL,
        http,
        format: "json",
        io: capTasks.io,
      });
      expect(tasksReport.tasks).toHaveLength(3);

      const capComplete = makeCapture();
      const completed = await runTaskComplete(
        { apiUrl: API_URL, http, format: "json", io: capComplete.io },
        "t1"
      );
      expect(completed.task.id).toBe("t1");
      expect(completed.task.columnId).toBe("col-doing");

      // ---- Network-shape assertions --------------------------------------
      // The journey must ride on the bearer token issued by the device
      // flow — verify every auth-required request carries it.
      const completeHeaders = calls[6].init?.headers as Record<string, string>;
      expect(completeHeaders.Authorization).toBe("Bearer at-journey-1");
      const tasksHeaders = calls[5].init?.headers as Record<string, string>;
      expect(tasksHeaders.Authorization).toBe("Bearer at-journey-1");

      // The OAuth choreography hit each endpoint in the expected order:
      // register → device/code → 2× token → boards → columns → complete.
      expect(calls.map((c) => c.url)).toEqual([
        `${API_URL}/oauth/register`,
        `${API_URL}/oauth/device/code`,
        `${API_URL}/oauth/token`,
        `${API_URL}/oauth/token`,
        `${API_URL}/api/v1/boards`,
        `${API_URL}/api/v1/columns`,
        `${API_URL}/api/v1/tasks/t1/complete`,
      ]);
    }
  );
});