// Tests for the auth sub-commands. The OAuthClient is replaced with a stub
// that records calls and returns canned responses; the HttpClient is mocked
// at the network boundary via vi.spyOn(globalThis, "fetch"). The fixtures
// cover the three scenarios the CLI contract guarantees:
//
//   - happy path: device flow returns a token; status/whoami succeed.
//   - denial:     authorizeInteractive throws / returns "denied".
//   - timeout:    authorizeInteractive throws / returns "expired".
//
// Run with `npm test` from the cli/ directory.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { InMemorySecretProvider, OAuthClient } from "./client.js";
import type { OAuthMetadata, TrackedPoll, TokenResponse } from "./types.js";
import { HttpClient } from "../http/client.js";
import {
  DeniedAuthorizationError,
  NotLoggedInError,
  authExitCodeForError,
  formatLoginSuccess,
  isUnknownClientIdError,
  runLogin,
  runLogout,
  runStatus,
  runWhoami,
} from "./commands.js";
import { AuthError, NetworkError } from "../http/client.js";
import { DeviceFlowError } from "./device-flow.js";

const metadata: OAuthMetadata = {
  issuer: "http://localhost:8080",
  authorization_endpoint: "http://localhost:8080/oauth/authorize",
  token_endpoint: "http://localhost:8080/oauth/token",
  jwks_uri: "http://localhost:8080/.well-known/jwks.json",
  registration_endpoint: "http://localhost:8080/oauth/register",
  device_authorization_endpoint: "http://localhost:8080/oauth/device/code",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

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

function makePoll(overrides: Partial<TrackedPoll> = {}): TrackedPoll {
  return {
    deviceCode: "dev-1",
    userCode: "ABCD-EFGH",
    verificationUri: "http://localhost:8080/oauth/device",
    verificationUriComplete: "http://localhost:8080/oauth/device?code=ABCD-EFGH",
    expiresAt: Date.now() + 600_000,
    intervalSeconds: 5,
    scope: "kanban:read tasks:write",
    clientId: "cid",
    ...overrides,
  };
}

interface FakeOAuthOptions {
  authorize?: (...args: unknown[]) => Promise<TokenResponse>;
  loadCredentials?: () => ReturnType<OAuthClient["loadCredentials"]>;
  clear?: () => void;
}

function makeFakeOAuth(opts: FakeOAuthOptions = {}) {
  const provider = new InMemorySecretProvider();
  const client = Object.create(OAuthClient.prototype) as OAuthClient & {
    authorizeInteractive: ReturnType<typeof vi.fn>;
    loadCredentials: ReturnType<typeof vi.fn>;
    secretProvider: InMemorySecretProvider;
  };
  client.secretProvider = provider;
  client.apiUrl = "http://localhost:8080";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.metadata = metadata as any;
  const defaultAuthorize = async () => {
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      clientName: "open-kanban-cli",
      accessToken: "at-1",
      refreshToken: "rt-1",
      accessExpiresAt: Date.now() + 3600_000,
      scope: "kanban:read",
    });
    return {
      access_token: "at-1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt-1",
      scope: "kanban:read",
    };
  };
  client.authorizeInteractive = vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
    if (opts.authorize) {
      const result = await (opts.authorize as (p: typeof params) => Promise<TokenResponse>)(params);
      provider.write({
        apiUrl: "http://localhost:8080",
        clientId: "cid",
        clientName: "open-kanban-cli",
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? "rt-1",
        accessExpiresAt: Date.now() + result.expires_in * 1000,
        scope: result.scope ?? "kanban:read",
      });
      return result;
    }
    return defaultAuthorize();
  });
  client.loadCredentials = vi.fn(() => opts.loadCredentials?.() ?? provider.read());
  client.secretProvider.clear = vi.fn(opts.clear ?? (() => provider.clear()));
  return client;
}

describe("runLogin", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the device flow and prints the prompt on stderr", async () => {
    const onPrompt = vi.fn(async () => "approve");
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
        const choice = await params.onPrompt?.(makePoll());
        expect(choice).toBe("approve");
        return {
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "kanban:read",
        };
      }),
    });
    // inject onPrompt via override by attaching to fake client authorize call
    void onPrompt;
    const cap = makeCapture();
    const result = await runLogin(
      { apiUrl: "http://localhost:8080", mode: "human" },
      { oauth, io: cap.io }
    );
    const { stderr } = cap.read();
    expect(stderr).toContain("Visit:");
    expect(stderr).toContain("ABCD-EFGH");
    expect(stderr).toContain("http://localhost:8080/oauth/device");
    // s-1131: the deep-link URL (with `?code=` pre-filled) is the
    // preferred Visit line so users can paste / click it without
    // retyping the code.
    expect(stderr).toContain("?code=ABCD-EFGH");
    expect(result.credentials?.accessToken).toBe("at-1");
  });

  it("prints the identity-selection hint when the client name looks like a CLI", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
        await params.onPrompt?.(makePoll());
        return {
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "kanban:read",
        };
      }),
    });
    const cap = makeCapture();
    await runLogin(
      { apiUrl: "http://localhost:8080", mode: "human" },
      { oauth, io: cap.io }
    );
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Identity selection/);
    expect(stderr).toMatch(/Agent/);
  });

  it("omits the identity-selection hint when the client name is not CLI-like", async () => {
    const oauth = makeFakeOAuth({
      // Load credentials with a non-CLI name so runLogin picks that
      // up; the default would otherwise match the heuristic.
      loadCredentials: () => null,
      authorize: vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
        await params.onPrompt?.(makePoll());
        return {
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "kanban:read",
        };
      }),
    });
    // Override authorizeInteractive so the test can drive clientName
    // directly. The fake client's authorizeInteractive always sets
    // clientName=open-kanban-cli internally; we patch it here by
    // wrapping a new method that doesn't read credsBefore.
    const cap = makeCapture();
    // To test the non-CLI branch we need a client whose credsBefore
    // resolves to a non-CLI name. Force-load a non-CLI name via
    // secretProvider.
    oauth.secretProvider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      clientName: "kanban-webapp",
      accessToken: "stale",
    });
    await runLogin(
      { apiUrl: "http://localhost:8080", mode: "human" },
      { oauth, io: cap.io }
    );
    const { stderr } = cap.read();
    expect(stderr).not.toMatch(/Identity selection/);
  });

  // s-1249: the CLI's DCR factory in src/auth/client.ts hardcodes
  // client_name="open-kanban-mcp", so the prompt-side heuristic must
  // also flag -mcp shapes. Without this branch `kanban auth login`
  // would land on the device page without the Agent identity picker
  // because the server-side heuristic never matched `open-kanban-mcp`
  // either — keeping the two sides in sync is what makes the picker
  // surface for the actual CLI flow.
  it("prints the identity-selection hint for open-kanban-mcp (s-1249)", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
        await params.onPrompt?.(makePoll());
        return {
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "kanban:read",
        };
      }),
    });
    // The fake client's authorizeInteractive always rewrites the
    // clientName to "open-kanban-cli"; the only way to exercise the
    // MCP-shaped name is to seed credentials with it before runLogin
    // reads credsBefore.
    oauth.secretProvider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      clientName: "open-kanban-mcp",
      accessToken: "stale",
    });
    const cap = makeCapture();
    await runLogin(
      { apiUrl: "http://localhost:8080", mode: "human" },
      { oauth, io: cap.io }
    );
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Identity selection/);
  });

  it("maps user denial to DeniedAuthorizationError (exit 3)", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async () => {
        throw new Error("user denied authorization");
      }),
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080", mode: "human" },
        { oauth, io: cap.io }
      )
    ).rejects.toBeInstanceOf(DeniedAuthorizationError);
    expect(authExitCodeForError(new DeniedAuthorizationError("user denied"))).toBe(3);
  });

  it("maps device-code expiry to DeniedAuthorizationError (exit 3)", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async () => {
        throw new Error("device code expired");
      }),
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080", mode: "human" },
        { oauth, io: cap.io }
      )
    ).rejects.toBeInstanceOf(DeniedAuthorizationError);
    expect(authExitCodeForError(new DeniedAuthorizationError("device code expired", "expired_token"))).toBe(3);
  });

  it("maps network failures during the device flow to NetworkError (exit 6)", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      }),
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080", mode: "human" },
        { oauth, io: cap.io }
      )
    ).rejects.toBeInstanceOf(NetworkError);
    expect(authExitCodeForError(new NetworkError("boom"))).toBe(6);
  });

  it("retries once after invalid_client / unknown client_id and clears stale credentials", async () => {
    // Simulates the s-1133 recovery path: the cached clientId was
    // wiped on the server (DB restore, oauth_clients pruned, ...).
    // First authorizeInteractive fails with the canonical error, the
    // second succeeds with a freshly issued clientId.
    const authorize = vi
      .fn<Parameters<OAuthClient["authorizeInteractive"]>, Promise<TokenResponse>>()
      .mockRejectedValueOnce(new DeviceFlowError("invalid_client", "unknown client_id"))
      .mockResolvedValueOnce({
        access_token: "at-recovered",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt-recovered",
        scope: "kanban:read tasks:write",
      });
    const oauth = makeFakeOAuth({ authorize });
    // Pre-seed a stale clientId so we can verify it gets cleared
    // before the retry.
    oauth.secretProvider.write({
      apiUrl: "http://localhost:8080",
      clientId: "stale-cid",
      clientName: "open-kanban-cli",
    });
    const cap = makeCapture();
    const result = await runLogin(
      { apiUrl: "http://localhost:8080", mode: "human" },
      { oauth, io: cap.io }
    );
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(result.credentials?.accessToken).toBe("at-recovered");
    const { stdout, stderr } = cap.read();
    // The retry path prints a yellow re-registering hint before the
    // second prompt, and the normal "Logged in to ..." line on success.
    expect(stderr).toMatch(/re-registering/i);
    expect(stderr).toContain("stale-cid");
    expect(stdout).toMatch(/Logged in to/);
  });

  it("surfaces the second failure when the retry also fails", async () => {
    const authorize = vi
      .fn<Parameters<OAuthClient["authorizeInteractive"]>, Promise<TokenResponse>>()
      .mockRejectedValueOnce(new DeviceFlowError("invalid_client", "unknown client_id"))
      .mockRejectedValueOnce(new Error("server unavailable"));
    const oauth = makeFakeOAuth({ authorize });
    oauth.secretProvider.write({
      apiUrl: "http://localhost:8080",
      clientId: "stale-cid",
      clientName: "open-kanban-cli",
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080", mode: "human" },
        { oauth, io: cap.io }
      )
    ).rejects.toThrow(/server unavailable/);
    expect(authorize).toHaveBeenCalledTimes(2);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Login failed/);
  });
});

// s-1231: `kanban auth login` defaults to binding the CLI to an
// Agent identity (since the CLI is almost always wired to an
// unattended runner). The legacy human-binding behaviour is
// available via `mode: 'human'` and exercised by the tests above.
describe("runLogin (agent mode)", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Stub the OAuthClient so the device flow resolves to a canned
  // token, and let the test fake /api/v1/users/me via scriptFetch
  // (see commands/agents.test.ts for the established pattern).
  function makeAgentReadyOAuth() {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async (params: { onPrompt?: (p: TrackedPoll) => Promise<"approve" | "deny"> }) => {
        await params.onPrompt?.(makePoll());
        return {
          access_token: "at-agent",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "kanban:read",
        };
      }),
    });
    return oauth;
  }

  it("throws a configuration error when deps.http is missing", async () => {
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    await expect(
      runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io })
    ).rejects.toThrow(/requires the HTTP client/);
  });

  it("defaults to agent mode and binds under the agent-token marker when the bound user is AGENT", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ user: { id: "agent-1", type: "AGENT", nickname: "ci-runner" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    const result = await runLogin(
      { apiUrl: "http://localhost:8080" },
      { oauth, http: new HttpClient({ apiUrl: "http://localhost:8080" }), io: cap.io }
    );
    expect(result.agent?.id).toBe("agent-1");
    expect(result.agent?.type).toBe("AGENT");
    const stored = oauth.loadCredentials();
    expect(stored?.clientId).toBe("agent:agent-1");
    expect(stored?.clientName).toBe("kanban-cli/agent-token");
    expect(stored?.accessToken).toBe("at-agent");
    const { stderr, stdout: agentStdout } = cap.read();
    expect(stderr).toMatch(/agent authorization/i);
    expect(stderr).toMatch(/bind existing agent|create new agent/i);
    // s-1232: the success line lives on stdout (matches the human-mode
    // contract so `--json` consumers + the e2e agent-selection test
    // can capture it without scraping stderr).
    expect(agentStdout).toMatch(/Logged in to/);
    expect(agentStdout).toMatch(/Agent ci-runner/);
    expect(agentStdout).toMatch(/type=AGENT/);
  });

  // s-1232: lock down the stream contract — the device-flow prompt +
  // identity-selection hint stay on stderr (operator-facing UX) while
  // the "Logged in to ..." success line lands on stdout. This matches
  // the human-mode behaviour and is the contract the e2e
  // `agent-selection.test.ts` suite asserts.
  it("keeps the device-flow prompt on stderr and writes the success line to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ user: { id: "agent-9", type: "AGENT", nickname: "alice-bot" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    await runLogin(
      { apiUrl: "http://localhost:8080" },
      { oauth, http: new HttpClient({ apiUrl: "http://localhost:8080" }), io: cap.io }
    );
    const { stderr, stdout: agentStdout } = cap.read();
    // Device-flow UX (verification URL, user code, scope, picker hint,
    // expiry countdown) stays on stderr.
    expect(stderr).toContain("Open Kanban agent authorization required");
    expect(stderr).toContain("Visit:");
    expect(stderr).toContain("ABCD-EFGH");
    expect(stderr).toContain("?code=ABCD-EFGH");
    expect(stderr).toContain("Waiting for approval");
    // Success line lives on stdout only — not duplicated to stderr.
    expect(stderr).not.toMatch(/Logged in to/);
    expect(agentStdout).toContain("Logged in to http://localhost:8080 as Agent alice-bot");
    expect(agentStdout).toContain("type=AGENT");
    // s-1246: the success block now includes host / identity / client
    // id / scope + next-step hints so operators see what they bound to.
    expect(agentStdout).toContain("Host:");
    expect(agentStdout).toContain("Identity:");
    expect(agentStdout).toContain("alice-bot");
    expect(agentStdout).toContain("Next steps:");
    expect(agentStdout).toContain("kanban mine");
  });

  it("skips the browser launch when openBrowser=false", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ user: { id: "agent-1", type: "AGENT", nickname: "x" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    const openSpy = vi.fn();
    await runLogin(
      { apiUrl: "http://localhost:8080", openBrowser: false },
      {
        oauth,
        http: new HttpClient({ apiUrl: "http://localhost:8080" }),
        io: cap.io,
      }
    );
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("invokes the injected openBrowserImpl with the deep-link verification URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ user: { id: "agent-1", type: "AGENT", nickname: "x" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    const openSpy = vi.fn();
    await runLogin(
      { apiUrl: "http://localhost:8080" },
      {
        oauth,
        http: new HttpClient({ apiUrl: "http://localhost:8080" }),
        openBrowserImpl: openSpy,
      }
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "http://localhost:8080/oauth/device?code=ABCD-EFGH"
    );
  });

  it("refuses to bind and restores previous credentials when the bound user is HUMAN", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          user: { id: "admin-1", type: "HUMAN", nickname: "Alice" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    // Pre-seed a valid previous credential so we can verify the
    // failure path restores it instead of clearing the store.
    oauth.secretProvider.write({
      apiUrl: "http://localhost:8080",
      clientId: "agent:old-runner",
      clientName: "kanban-cli/agent-token",
      accessToken: "at-old",
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080" },
        {
          oauth,
          http: new HttpClient({ apiUrl: "http://localhost:8080" }),
          io: cap.io,
        }
      )
    ).rejects.toThrow(/requires an Agent token/);
    const stored = oauth.loadCredentials();
    expect(stored?.clientId).toBe("agent:old-runner");
    expect(stored?.accessToken).toBe("at-old");
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Refusing to bind/);
  });

  // s-1247: when the device flow resolves to a HUMAN user (the
  // approver picked "Myself" / their personal account on the
  // approval page) the CLI refuses to bind. The error must spell
  // out both the wrong radio-button choice and the right one so an
  // operator can recover with a single re-run, plus mention the
  // `--as-human` opt-in for operators who genuinely wanted a
  // personal-account binding. Lock all three lines down so a
  // future tweak doesn't accidentally drop the actionable hint.
  it("surfaces an actionable remediation hint when the bound user is HUMAN (s-1247)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          user: { id: "admin-1", type: "HUMAN", nickname: "Alice" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080" },
        {
          oauth,
          http: new HttpClient({ apiUrl: "http://localhost:8080" }),
          io: cap.io,
        }
      )
    ).rejects.toThrow(/requires an Agent token/);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Refusing to bind/);
    // Tells the operator which radio button is wrong.
    expect(stderr).toMatch(/do NOT pick .Myself./i);
    // Tells the operator which radio button is right.
    expect(stderr).toMatch(/Bind existing agent.*Create new agent/);
    // Tells the operator about the --as-human escape hatch.
    expect(stderr).toMatch(/--as-human/);
    // Confirms the previous credential snapshot was left intact so
    // the operator doesn't have to `auth logout` before re-running.
    expect(stderr).toMatch(/previous credentials were left unchanged/i);
  });

  it("maps user denial to DeniedAuthorizationError (exit 3) in agent mode", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async () => {
        throw new Error("user denied authorization");
      }),
    });
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080" },
        {
          oauth,
          http: new HttpClient({ apiUrl: "http://localhost:8080" }),
          io: cap.io,
        }
      )
    ).rejects.toBeInstanceOf(DeniedAuthorizationError);
  });

  it("maps network failures during /api/v1/users/me to a typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const oauth = makeAgentReadyOAuth();
    const cap = makeCapture();
    await expect(
      runLogin(
        { apiUrl: "http://localhost:8080" },
        {
          oauth,
          http: new HttpClient({ apiUrl: "http://localhost:8080" }),
          io: cap.io,
        }
      )
    ).rejects.toThrow(/network error/);
    const { stderr } = cap.read();
    expect(stderr).toMatch(/Network error/);
  });
});

describe("isUnknownClientIdError", () => {
  it("matches DeviceFlowError with code invalid_client", () => {
    expect(isUnknownClientIdError(new DeviceFlowError("invalid_client", "unknown client_id"))).toBe(true);
  });

  it("matches DeviceFlowError whose message describes an unknown client_id", () => {
    expect(isUnknownClientIdError(new DeviceFlowError("server_error", "invalid_client: unknown client_id stale-cid"))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isUnknownClientIdError(new Error("user denied authorization"))).toBe(false);
    expect(isUnknownClientIdError(new Error("network error: ECONNREFUSED"))).toBe(false);
    expect(isUnknownClientIdError(new DeviceFlowError("authorization_pending", "still waiting"))).toBe(false);
    expect(isUnknownClientIdError(null)).toBe(false);
    expect(isUnknownClientIdError(undefined)).toBe(false);
  });
});

describe("runStatus", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws NotLoggedInError when no credentials exist (exit 2)", async () => {
    const oauth = makeFakeOAuth({ loadCredentials: () => null });
    const cap = makeCapture();
    await expect(
      runStatus({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(authExitCodeForError(new NotLoggedInError())).toBe(2);
  });

  it("prints host, client id, scope, and token lifetime", async () => {
    const expiresAt = Date.now() + 650_000;
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        clientName: "open-kanban-cli",
        accessToken: "at-1",
        refreshToken: "rt-1",
        accessExpiresAt: expiresAt,
        scope: "kanban:read tasks:write",
      }),
    });
    const cap = makeCapture();
    const report = await runStatus(
      { apiUrl: "http://localhost:8080", profile: "work" },
      { oauth, io: cap.io }
    );
    const { stdout } = cap.read();
    expect(stdout).toContain("Host:");
    expect(stdout).toContain("http://localhost:8080");
    expect(stdout).toContain("cid-1");
    expect(stdout).toContain("kanban:read tasks:write");
    expect(report.clientId).toBe("cid-1");
    expect(report.profile).toBe("work");
    expect(report.apiUrl).toBe("http://localhost:8080");
    expect(report.hasRefreshToken).toBe(true);
    expect(report.accessTokenRemainingSeconds).toBeGreaterThan(500);
  });

  it("reports expired tokens with the refresh hint", async () => {
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        accessToken: "at-old",
        refreshToken: "rt-1",
        accessExpiresAt: Date.now() - 1000,
        scope: "kanban:read",
      }),
    });
    const cap = makeCapture();
    await runStatus({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io });
    expect(cap.read().stdout).toMatch(/expired|refresh/);
  });
});

describe("runLogout", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears stored credentials via secretProvider.clear()", async () => {
    const clearSpy = vi.fn();
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid",
        accessToken: "at",
        refreshToken: "rt",
      }),
      clear: clearSpy,
    });
    const cap = makeCapture();
    const result = await runLogout(
      { apiUrl: "http://localhost:8080" },
      { oauth, io: cap.io }
    );
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(result.removed).toBe(true);
    expect(cap.read().stdout).toContain("Logged out");
  });

  it("is idempotent when no credentials exist", async () => {
    const clearSpy = vi.fn();
    const oauth = makeFakeOAuth({
      loadCredentials: () => null,
      clear: clearSpy,
    });
    const cap = makeCapture();
    const result = await runLogout(
      { apiUrl: "http://localhost:8080" },
      { oauth, io: cap.io }
    );
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(result.removed).toBe(false);
    expect(cap.read().stdout).toMatch(/nothing to do/);
  });
});

describe("runWhoami", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(spy);
    return { calls, spy };
  }

  it("calls GET /api/v1/users/me with the bearer token and prints the user", async () => {
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        accessToken: "at-fresh",
        refreshToken: "rt-1",
        accessExpiresAt: Date.now() + 3600_000,
        scope: "kanban:read",
      }),
    });
    const { calls } = mockFetch([
      {
        status: 200,
        body: {
          user: { id: "u-1", username: "alice", nickname: "Alice", type: "user", role: "admin" },
          permissions: [{ boardId: "b1", boardName: "Demo", access: "admin" }],
          needsSetup: false,
        },
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient();
    const report = await runWhoami(
      { apiUrl: "http://localhost:8080" },
      { oauth, http, io: cap.io }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/users/me");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
    expect(report.user.username).toBe("alice");
    expect(report.user.nickname).toBe("Alice");
    expect(report.user.role).toBe("admin");
    const { stdout } = cap.read();
    expect(stdout).toContain("alice");
    expect(stdout).toContain("Alice");
    expect(stdout).toContain("admin");
  });

  it("throws NotLoggedInError when no credentials are on disk (exit 2)", async () => {
    const oauth = makeFakeOAuth({ loadCredentials: () => null });
    const cap = makeCapture();
    const http = new HttpClient();
    await expect(
      runWhoami({ apiUrl: "http://localhost:8080" }, { oauth, http, io: cap.io })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(authExitCodeForError(new NotLoggedInError())).toBe(2);
  });

  it("maps a 401 response to NotLoggedInError (exit 2)", async () => {
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        accessToken: "at-old",
        refreshToken: "rt-1",
        accessExpiresAt: Date.now() + 3600_000,
      }),
    });
    mockFetch([
      { status: 401, body: { error: "invalid_token" } },
      // refresh succeeds but the retried request still returns 401
      { status: 200, body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-new" } },
      { status: 401, body: { error: "invalid_token" } },
    ]);
    const cap = makeCapture();
    const http = new HttpClient();
    await expect(
      runWhoami({ apiUrl: "http://localhost:8080" }, { oauth, http, io: cap.io })
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(authExitCodeForError(new NotLoggedInError())).toBe(2);
  });

  it("maps network failures to NetworkError (exit 6)", async () => {
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        accessToken: "at-1",
        refreshToken: "rt-1",
        accessExpiresAt: Date.now() + 3600_000,
      }),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const cap = makeCapture();
    const http = new HttpClient();
    await expect(
      runWhoami({ apiUrl: "http://localhost:8080" }, { oauth, http, io: cap.io })
    ).rejects.toBeInstanceOf(NetworkError);
    expect(authExitCodeForError(new NetworkError("boom"))).toBe(6);
  });

  it("allows overriding the endpoint path", async () => {
    const oauth = makeFakeOAuth({
      loadCredentials: () => ({
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        accessToken: "at-1",
        refreshToken: "rt-1",
        accessExpiresAt: Date.now() + 3600_000,
      }),
    });
    const { calls } = mockFetch([
      {
        status: 200,
        body: { user: { id: "u-1", username: "alice" }, needsSetup: false },
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient();
    await runWhoami(
      { apiUrl: "http://localhost:8080" },
      { oauth, http, path: "/api/auth/me", io: cap.io }
    );
    expect(calls[0].url).toBe("http://localhost:8080/api/auth/me");
  });
});

describe("authExitCodeForError", () => {
  it("maps known error types to the documented exit codes", () => {
    expect(authExitCodeForError(new NotLoggedInError())).toBe(2);
    expect(authExitCodeForError(new AuthError("x", { path: "/" }))).toBe(2);
    expect(authExitCodeForError(new DeniedAuthorizationError("denied"))).toBe(3);
    expect(authExitCodeForError(new NetworkError("boom"))).toBe(6);
    expect(authExitCodeForError(new Error("user denied authorization"))).toBe(3);
    expect(authExitCodeForError(new Error("ECONNREFUSED network down"))).toBe(6);
    expect(authExitCodeForError(new Error("something else"))).toBe(1);
    expect(authExitCodeForError("string error")).toBe(1);
    expect(authExitCodeForError(null)).toBe(1);
  });
});

// s-1246: the post-login success block has to (a) keep the historical
// "Logged in to <url> as ..." headline so the e2e agent-selection
// suite and shell scripts that grep for that marker still match, and
// (b) surface enough extra context (host / identity / client id /
// scope + next-step hints) that an operator knows what they just
// bound to. formatLoginSuccess is the single source of truth — both
// runLoginAsAgent and runLoginAsHuman call it.
describe("formatLoginSuccess", () => {
  it("renders the agent-mode success block with identity details and next-step hints", () => {
    const text = formatLoginSuccess({
      apiUrl: "http://localhost:8080",
      mode: "agent",
      profile: "default",
      scope: "kanban:read tasks:write comments:write",
      credentials: {
        apiUrl: "http://localhost:8080",
        clientId: "agent:agent-9",
        clientName: "kanban-cli/agent-token",
        accessToken: "at-9",
      },
      agent: { id: "agent-9", nickname: "alice-bot", type: "AGENT" },
    });
    // s-1232 contract — the historical "Logged in to ..." line is
    // the first line on stdout. Pin it here so a regression that
    // drops the headline breaks loudly.
    expect(text).toMatch(/Logged in to http:\/\/localhost:8080 as Agent alice-bot/);
    expect(text).toContain("type=AGENT");
    // s-1246 additions: host / identity / client id / scope / next
    // steps. The agent flow nudges the operator towards `kanban
    // mine` / `kanban run init` because those are the most common
    // post-login actions for the unattended-runner case.
    expect(text).toContain("Host:");
    expect(text).toContain("http://localhost:8080");
    expect(text).toContain("Profile:");
    expect(text).toContain("default");
    expect(text).toContain("Identity:");
    expect(text).toContain("alice-bot");
    expect(text).toContain("agent-9");
    expect(text).toContain("Client ID:");
    expect(text).toContain("agent:agent-9");
    expect(text).toContain("Scope:");
    expect(text).toContain("kanban:read tasks:write comments:write");
    expect(text).toContain("Next steps:");
    expect(text).toContain("kanban auth status");
    expect(text).toContain("kanban mine");
    expect(text).toContain("kanban run init");
    // Human-only next-steps must not leak into the agent block.
    expect(text).not.toContain("kanban tasks list");
  });

  it("renders the human-mode success block with the human-specific next-step hints", () => {
    const text = formatLoginSuccess({
      apiUrl: "https://kanban.example.com",
      mode: "human",
      profile: "work",
      scope: "kanban:read",
      credentials: {
        apiUrl: "https://kanban.example.com",
        clientId: "cid-1",
        clientName: "open-kanban-cli",
        accessToken: "at-1",
      },
    });
    expect(text).toMatch(/Logged in to https:\/\/kanban\.example\.com as cid-1/);
    expect(text).toContain("Scope:");
    expect(text).toContain("kanban:read");
    // Human flow nudges the operator towards `kanban whoami` /
    // `kanban tasks list` instead of the agent-only commands.
    expect(text).toContain("kanban auth status");
    expect(text).toContain("kanban whoami");
    expect(text).toContain("kanban tasks list");
    expect(text).not.toContain("kanban mine");
    expect(text).not.toContain("kanban run init");
  });

  it("falls back to the stored scope when the caller does not pass one explicitly", () => {
    const text = formatLoginSuccess({
      apiUrl: "http://localhost:8080",
      mode: "human",
      credentials: {
        apiUrl: "http://localhost:8080",
        clientId: "cid-1",
        clientName: "open-kanban-cli",
        accessToken: "at-1",
        scope: "kanban:read",
      },
    });
    expect(text).toContain("Scope:");
    expect(text).toContain("kanban:read");
  });

  it("hides the Profile line when no profile is set", () => {
    const text = formatLoginSuccess({
      apiUrl: "http://localhost:8080",
      mode: "agent",
      credentials: {
        apiUrl: "http://localhost:8080",
        clientId: "agent:agent-1",
        clientName: "kanban-cli/agent-token",
        accessToken: "at-1",
      },
      agent: { id: "agent-1", type: "AGENT" },
    });
    expect(text).toContain("Identity:");
    expect(text).not.toContain("Profile:");
  });
});
