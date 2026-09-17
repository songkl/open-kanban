// Tests for the `kanban auth agent` sub-commands.
//
// The four commands under test (`runAgentsList`, `runAgentCreate`,
// `runAgentBind`, `runAgentDelete`) all hit the /api/v1/auth/agents
// endpoints. HttpClient is exercised through vi.spyOn(globalThis, "fetch")
// so the assertions cover the request shape (URL, method, body, query),
// the response handling (200/401/403/404), and the credential-store
// side-effects on the supplied OAuthClient.
//
// The `bind` command verifies the token against GET /api/v1/users/me via
// a raw fetch (no HttpClient), so those tests have to assert on the
// outgoing URL + Authorization header directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import {
  HttpClient,
  AuthError,
  NotFoundError,
} from "../http/client.js";
import {
  InMemorySecretProvider,
  OAuthClient,
} from "../auth/client.js";
import {
  runAgentsList,
  runAgentCreate,
  runAgentBind,
  runAgentDelete,
  writeAgentToken,
  CLIENT_NAME_AGENT,
} from "./agents.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import type { OAuthMetadata } from "../auth/types.js";

const METADATA: OAuthMetadata = {
  issuer: "http://kanban.example.com",
  authorization_endpoint: "http://kanban.example.com/oauth/authorize",
  token_endpoint: "http://kanban.example.com/oauth/token",
  jwks_uri: "http://kanban.example.com/.well-known/jwks.json",
  registration_endpoint: "http://kanban.example.com/oauth/register",
  device_authorization_endpoint: "http://kanban.example.com/oauth/device/code",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read"],
};

function makeOAuth(): OAuthClient {
  const provider = new InMemorySecretProvider();
  return new OAuthClient(
    "http://kanban.example.com",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    METADATA as any,
    provider
  );
}

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
      { status: r.status, headers: { "Content-Type": "application/json" } }
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

const AGENT_PAYLOAD = {
  id: "agent-1",
  nickname: "ci-runner",
  avatar: "",
  type: "AGENT",
  role: "ADMIN",
  enabled: true,
  createdAt: "2026-09-12T00:00:00Z",
  tokenCount: 1,
  // s-1131: creator identification. Real server responses from
  // 0.8.0+ include these fields; older payloads leave them off so
  // the table renders a "(legacy)" placeholder.
  createdBy: "admin-1",
  createdByNickname: "Alice Admin",
  createdByUsername: "alice",
};

const AGENTS_LIST_PAYLOAD = {
  agents: [
    AGENT_PAYLOAD,
    {
      ...AGENT_PAYLOAD,
      id: "agent-2",
      nickname: "docs-bot",
      role: "MEMBER",
      lastActiveAt: "2026-09-11T12:34:56Z",
      createdBy: "admin-2",
      createdByNickname: "Bob Owner",
      createdByUsername: "bob",
    },
  ],
};

const AGENT_CREATE_RESPONSE = {
  agent: AGENT_PAYLOAD,
  token: "agent-secret-token-1234",
};

describe("runAgentsList", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs /api/v1/auth/agents and unwraps {agents: [...]}", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: AGENTS_LIST_PAYLOAD },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/auth/agents");
    expect(report.agents).toHaveLength(2);
    expect(report.agents[0].id).toBe("agent-1");
    expect(report.agents[1].id).toBe("agent-2");
  });

  it("accepts a plain array payload (server variant)", async () => {
    scriptFetch([{ status: 200, body: AGENTS_LIST_PAYLOAD.agents }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const report = await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
    });
    expect(report.agents).toHaveLength(2);
  });

  it("renders a tabular summary by default", async () => {
    scriptFetch([{ status: 200, body: AGENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Agents");
    expect(stdout).toContain("agent-1");
    expect(stdout).toContain("agent-2");
    expect(stdout).toContain("ci-runner");
    expect(stdout).toContain("docs-bot");
    expect(stdout).toContain("2026-09-11T12:34:56Z");
  });

  it("renders table-mode 'never' for agents without lastActiveAt", async () => {
    scriptFetch([{ status: 200, body: { agents: [AGENT_PAYLOAD] } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("never");
  });

  it("renders the 'Created by' column when the server returns creator info (s-1131)", async () => {
    scriptFetch([{ status: 200, body: AGENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Created by");
    expect(stdout).toContain("Alice Admin");
    expect(stdout).toContain("Bob Owner");
  });

  it("hides the 'Created by' column when the server returns no creator info (legacy servers)", async () => {
    const legacyPayload = {
      agents: [
        {
          id: "agent-legacy",
          nickname: "legacy-bot",
          type: "AGENT",
          role: "ADMIN",
          enabled: true,
          createdAt: "2026-08-01T00:00:00Z",
          tokenCount: 1,
        },
      ],
    };
    scriptFetch([{ status: 200, body: legacyPayload }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).not.toContain("Created by");
  });

  it("renders '(legacy)' for individual rows whose server omitted the creator", async () => {
    // Mixed payload — one row carries the creator, the other
    // does not. The column stays on (because at least one row
    // has the field) but the missing row gets the placeholder.
    const mixed = {
      agents: [
        AGENT_PAYLOAD,
        {
          id: "agent-legacy",
          nickname: "legacy-bot",
          type: "AGENT",
          role: "ADMIN",
          enabled: true,
          createdAt: "2026-08-01T00:00:00Z",
          tokenCount: 1,
        },
      ],
    };
    scriptFetch([{ status: 200, body: mixed }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("Created by");
    expect(stdout).toContain("Alice Admin");
    expect(stdout).toContain("(legacy)");
  });

  it("renders '(no agents)' when the list is empty", async () => {
    scriptFetch([{ status: 200, body: { agents: [] } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      io: cap.io,
    });
    expect(cap.read().stdout).toContain("(no agents)");
  });

  it("emits JSON when format=json", async () => {
    scriptFetch([{ status: 200, body: AGENTS_LIST_PAYLOAD }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const cap = makeCapture();
    const report = await runAgentsList({
      apiUrl: "http://kanban.example.com",
      http,
      format: "json",
      io: cap.io,
    });
    const parsed = JSON.parse(cap.read().stdout.trim());
    expect(parsed.apiUrl).toBe("http://kanban.example.com");
    expect(parsed.agents).toHaveLength(2);
    expect(report.agents).toHaveLength(2);
  });

  it("rewrites 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Unauthorized" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runAgentsList({ apiUrl: "http://kanban.example.com", http })
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("runAgentCreate", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the nickname + role to /api/v1/auth/agents and persists the token", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: AGENT_CREATE_RESPONSE },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    const cap = makeCapture();
    const result = await runAgentCreate(
      {
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
        io: cap.io,
      },
      "ci-runner"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/auth/agents");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({ nickname: "ci-runner", role: "ADMIN" });
    expect(result.agent.id).toBe("agent-1");
    expect(result.token).toBe("agent-secret-token-1234");
    expect(result.bound).toBe(true);
    const stored = oauth.secretProvider.read();
    expect(stored?.accessToken).toBe("agent-secret-token-1234");
    expect(stored?.clientName).toBe(CLIENT_NAME_AGENT);
    expect(stored?.clientId).toBe("agent:agent-1");
  });

  it("forwards the optional --avatar", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: AGENT_CREATE_RESPONSE },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await runAgentCreate(
      {
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
        avatar: "https://example.com/avatar.png",
        role: "MEMBER",
      },
      "ci-runner"
    );
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({
      nickname: "ci-runner",
      avatar: "https://example.com/avatar.png",
      role: "MEMBER",
    });
  });

  it("surfaces the creator in the create table when the server returns it (s-1131)", async () => {
    scriptFetch([{ status: 200, body: AGENT_CREATE_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    const cap = makeCapture();
    const result = await runAgentCreate(
      {
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
        io: cap.io,
      },
      "ci-runner"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Created by");
    expect(stdout).toContain("admin-1");
    // And the typed result mirrors the server payload.
    expect(result.agent.createdBy).toBe("admin-1");
  });

  it("reports bound=false when --no-bind is passed (dry-run)", async () => {
    scriptFetch([{ status: 200, body: AGENT_CREATE_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    const result = await runAgentCreate(
      {
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
        bindWhenFinished: false,
      },
      "ci-runner"
    );
    expect(result.bound).toBe(false);
    expect(oauth.secretProvider.read()).toBeNull();
  });

  it("rejects empty / whitespace nicknames with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentCreate(
        { apiUrl: "http://kanban.example.com", http, oauth },
        "   "
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects invalid --role values", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentCreate(
        {
          apiUrl: "http://kanban.example.com",
          http,
          oauth,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: "GOD" as any,
        },
        "ci-runner"
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rewrites 401 to NotLoggedInError (admin session missing)", async () => {
    scriptFetch([{ status: 401, body: { error: "Unauthorized" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentCreate(
        { apiUrl: "http://kanban.example.com", http, oauth },
        "ci-runner"
      )
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("lets 403 surface as the underlying ApiError (admin required)", async () => {
    scriptFetch([{ status: 403, body: { error: "Forbidden" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentCreate(
        { apiUrl: "http://kanban.example.com", http, oauth },
        "ci-runner"
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("renders the resulting token with a security hint in table mode", async () => {
    scriptFetch([{ status: 200, body: AGENT_CREATE_RESPONSE }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    const cap = makeCapture();
    await runAgentCreate(
      {
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
        io: cap.io,
      },
      "ci-runner"
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("agent-secret-token-1234");
    expect(stdout).toContain("Store this token");
  });
});

describe("runAgentBind", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
    delete process.env.KANBAN_AGENT_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates the token against /api/v1/users/me and persists it on success", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: { user: { id: "agent-99", type: "AGENT", nickname: "k8s-bot" } },
      },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    const result = await runAgentBind({
      apiUrl: "http://kanban.example.com",
      token: "valid-token-xyz",
      http,
      oauth,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/users/me");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer valid-token-xyz");
    expect(result.agent.id).toBe("agent-99");
    expect(result.bound).toBe(true);
    const stored = oauth.secretProvider.read();
    expect(stored?.accessToken).toBe("valid-token-xyz");
    expect(stored?.clientName).toBe(CLIENT_NAME_AGENT);
    expect(stored?.clientId).toBe("agent:agent-99");
  });

  it("falls back to KANBAN_AGENT_TOKEN when --token is omitted", async () => {
    scriptFetch([
      {
        status: 200,
        body: { user: { id: "agent-1", type: "AGENT", nickname: "x" } },
      },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    process.env.KANBAN_AGENT_TOKEN = "env-token";
    await runAgentBind({
      apiUrl: "http://kanban.example.com",
      http,
      oauth,
    });
    const stored = oauth.secretProvider.read();
    expect(stored?.accessToken).toBe("env-token");
  });

  it("prompts the user when neither --token nor env is supplied", async () => {
    scriptFetch([
      {
        status: 200,
        body: { user: { id: "agent-1", type: "AGENT", nickname: "x" } },
      },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await runAgentBind({
      apiUrl: "http://kanban.example.com",
      http,
      oauth,
      prompt: async () => "prompted-token",
    });
    const stored = oauth.secretProvider.read();
    expect(stored?.accessToken).toBe("prompted-token");
  });

  it("rejects an empty token source with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentBind({
        apiUrl: "http://kanban.example.com",
        http,
        oauth,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("refuses to bind when the resolved user is HUMAN (not AGENT)", async () => {
    scriptFetch([
      {
        status: 200,
        body: { user: { id: "u-1", type: "HUMAN", nickname: "Alice" } },
      },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentBind({
        apiUrl: "http://kanban.example.com",
        token: "human-token",
        http,
        oauth,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
    expect(oauth.secretProvider.read()).toBeNull();
  });

  it("treats 401 from /me as an invalid token", async () => {
    scriptFetch([{ status: 401, body: { error: "Unauthorized" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentBind({
        apiUrl: "http://kanban.example.com",
        token: "bad-token",
        http,
        oauth,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("treats 404 from /me as an invalid token", async () => {
    scriptFetch([{ status: 404, body: { error: "Not Found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const oauth = makeOAuth();
    await expect(
      runAgentBind({
        apiUrl: "http://kanban.example.com",
        token: "bad-token",
        http,
        oauth,
      })
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });
});

describe("runAgentDelete", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs /api/v1/auth/agents?id=<id>", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { success: true } },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    const result = await runAgentDelete(
      { apiUrl: "http://kanban.example.com", http },
      "agent-1"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("DELETE");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/auth/agents");
    expect(url.searchParams.get("id")).toBe("agent-1");
    expect(result.success).toBe(true);
    expect(result.id).toBe("agent-1");
  });

  it("encodes agent ids with special characters", async () => {
    const { calls } = scriptFetch([
      { status: 200, body: { success: true } },
    ]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await runAgentDelete(
      { apiUrl: "http://kanban.example.com", http },
      "agent/with slash"
    );
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("id")).toBe("agent/with slash");
  });

  it("rejects empty agent ids with InvalidUsageError", async () => {
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runAgentDelete({ apiUrl: "http://kanban.example.com", http }, "  ")
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rewrites 401 to NotLoggedInError", async () => {
    scriptFetch([{ status: 401, body: { error: "Unauthorized" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runAgentDelete({ apiUrl: "http://kanban.example.com", http }, "agent-1")
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("rewrites 404 to NotFoundError", async () => {
    scriptFetch([{ status: 404, body: { error: "Not Found" } }]);
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    await expect(
      runAgentDelete({ apiUrl: "http://kanban.example.com", http }, "ghost")
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("writeAgentToken", () => {
  it("persists the token under the agent-id client marker", () => {
    const oauth = makeOAuth();
    const ok = writeAgentToken(oauth, "http://kanban.example.com/", "tok", {
      id: "agent-42",
      nickname: "k8s",
    });
    expect(ok).toBe(true);
    const stored = oauth.secretProvider.read();
    expect(stored?.apiUrl).toBe("http://kanban.example.com");
    expect(stored?.clientId).toBe("agent:agent-42");
    expect(stored?.clientName).toBe(CLIENT_NAME_AGENT);
    expect(stored?.accessToken).toBe("tok");
    expect(stored?.refreshToken).toBeUndefined();
    expect(stored?.accessExpiresAt).toBeUndefined();
  });

  it("falls back to 'agent-unknown' when the id is blank", () => {
    const oauth = makeOAuth();
    writeAgentToken(oauth, "http://kanban.example.com", "tok", {});
    const stored = oauth.secretProvider.read();
    expect(stored?.clientId).toBe("agent:agent-unknown");
  });
});

// Re-export so unused-import warnings don't fire when this file is the
// sole consumer of AuthError / NotFoundError in a stripped build.
void AuthError;
