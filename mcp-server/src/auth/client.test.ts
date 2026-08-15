import { describe, it, expect, vi, beforeEach } from "vitest";
import { OAuthClient, InMemorySecretProvider } from "./client.js";
import type { OAuthMetadata } from "./types.js";

const metadataFixture: OAuthMetadata = {
  issuer: "http://localhost",
  authorization_endpoint: "http://localhost/oauth/authorize",
  token_endpoint: "http://localhost/oauth/token",
  jwks_uri: "http://localhost/.well-known/jwks.json",
  registration_endpoint: "http://localhost/oauth/register",
  device_authorization_endpoint: "http://localhost/oauth/device/code",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["kanban:read", "tasks:write"]
};

function mockFetchSequence(responses: Array<{ status: number; body: any }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

describe("OAuthClient discovery + DCR + device flow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs discovery and registers a new client", async () => {
    mockFetchSequence([
      { status: 200, body: metadataFixture },
      { status: 201, body: { client_id: "cid-1", scope: "kanban:read" } }
    ]);
    const provider = new InMemorySecretProvider();
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const creds = await client.ensureRegistered();
    expect(creds.clientId).toBe("cid-1");
    expect(creds.scope).toBe("kanban:read");
    expect(provider.read()?.clientId).toBe("cid-1");
  });

  it("reuses an existing client when one is on disk", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({ apiUrl: "http://localhost", clientId: "existing-cid" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(metadataFixture), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const creds = await client.ensureRegistered();
    expect(creds.clientId).toBe("existing-cid");
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the discovery call
  });

  it("rejects mismatched apiUrl on disk", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({ apiUrl: "http://other", clientId: "cid-old" });
    mockFetchSequence([
      { status: 200, body: metadataFixture },
      { status: 201, body: { client_id: "cid-new", scope: "kanban:read" } }
    ]);
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const creds = await client.ensureRegistered();
    expect(creds.clientId).toBe("cid-new");
  });

  it("runs the device flow end-to-end", async () => {
    const pollNow = Date.now();
    vi.setSystemTime(pollNow);
    mockFetchSequence([
      { status: 200, body: metadataFixture },
      { status: 201, body: { client_id: "cid-1", scope: "kanban:read" } },
      {
        status: 200,
        body: {
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "http://localhost/oauth/device",
          expires_in: 600,
          interval: 5
        }
      },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "kanban:read" } }
    ]);
    const provider = new InMemorySecretProvider();
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const tok = await client.authorizeInteractive({
      apiUrl: "http://localhost",
      secretProvider: provider,
      onPrompt: async () => "approve",
      sleepFn: async () => undefined
    });
    expect(tok.access_token).toBe("at-1");
    expect(provider.read()?.refreshToken).toBe("rt-1");
    vi.useRealTimers();
  });

  it("slow_down extends the interval and keeps polling", async () => {
    const pollNow = Date.now();
    vi.setSystemTime(pollNow);
    mockFetchSequence([
      { status: 200, body: metadataFixture },
      { status: 201, body: { client_id: "cid-1", scope: "kanban:read" } },
      {
        status: 200,
        body: {
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "http://localhost/oauth/device",
          expires_in: 600,
          interval: 5
        }
      },
      { status: 400, body: { error: "slow_down", error_description: "polling too frequently" } },
      { status: 200, body: { access_token: "at-2", token_type: "Bearer", expires_in: 3600 } }
    ]);
    const provider = new InMemorySecretProvider();
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const onPoll = vi.fn();
    const tok = await client.authorizeInteractive({
      apiUrl: "http://localhost",
      secretProvider: provider,
      onPrompt: async () => "approve",
      onPoll,
      sleepFn: async () => undefined
    });
    expect(tok.access_token).toBe("at-2");
    expect(onPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "slow_down" }));
    vi.useRealTimers();
  });

  it("throws when the user denies in the prompt", async () => {
    mockFetchSequence([
      { status: 200, body: metadataFixture },
      { status: 201, body: { client_id: "cid-1", scope: "kanban:read" } },
      {
        status: 200,
        body: {
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "http://localhost/oauth/device",
          expires_in: 600,
          interval: 5
        }
      }
    ]);
    const provider = new InMemorySecretProvider();
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    await expect(
      client.authorizeInteractive({
        apiUrl: "http://localhost",
        secretProvider: provider,
        onPrompt: async () => "deny",
        sleepFn: async () => undefined
      })
    ).rejects.toThrow(/denied/);
  });

  it("refreshes tokens using the stored refresh_token", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost",
      clientId: "cid-1",
      refreshToken: "rt-old"
    });
    mockFetchSequence([
      {
        status: 200,
        body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-new" }
      }
    ]);
    const client = await OAuthClient.fromConfig({
      apiUrl: "http://localhost",
      secretProvider: provider
    });
    const tok = await client.refreshTokens();
    expect(tok.access_token).toBe("at-new");
    expect(provider.read()?.refreshToken).toBe("rt-new");
  });
});