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
  runLogin,
  runLogout,
  runStatus,
  runWhoami,
} from "./commands.js";
import { AuthError, NetworkError } from "../http/client.js";

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
      { apiUrl: "http://localhost:8080" },
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
    await runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io });
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
    await runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io });
    const { stderr } = cap.read();
    expect(stderr).not.toMatch(/Identity selection/);
  });

  it("maps user denial to DeniedAuthorizationError (exit 3)", async () => {
    const oauth = makeFakeOAuth({
      authorize: vi.fn(async () => {
        throw new Error("user denied authorization");
      }),
    });
    const cap = makeCapture();
    await expect(
      runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io })
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
      runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io })
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
      runLogin({ apiUrl: "http://localhost:8080" }, { oauth, io: cap.io })
    ).rejects.toBeInstanceOf(NetworkError);
    expect(authExitCodeForError(new NetworkError("boom"))).toBe(6);
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
