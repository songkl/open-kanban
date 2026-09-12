import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiError,
  AuthError,
  HttpClient,
  NetworkError,
  NotFoundError,
  ServerError,
  exitCodeForError,
} from "./client.js";
import { InMemorySecretProvider, OAuthClient } from "../auth/client.js";
import type { OAuthMetadata } from "../auth/types.js";

const metadataFixture: OAuthMetadata = {
  issuer: "http://localhost:8080",
  authorization_endpoint: "http://localhost:8080/oauth/authorize",
  token_endpoint: "http://localhost:8080/oauth/token",
  jwks_uri: "http://localhost:8080/.well-known/jwks.json",
  registration_endpoint: "http://localhost:8080/oauth/register",
  device_authorization_endpoint: "http://localhost:8080/oauth/device/code",
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  status: number;
  body?: any;
  headers?: Record<string, string>;
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
      headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return { calls, spy };
}

function makeOAuthClient(provider: InMemorySecretProvider): OAuthClient {
  return new OAuthClient("http://localhost:8080", metadataFixture, provider);
}

describe("HttpClient", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("apiGet sends GET with the correct URL and Accept header", async () => {
    const { calls } = scriptFetch([{ status: 200, body: { hello: "world" } }]);
    const client = new HttpClient();
    const data = await client.apiGet<{ hello: string }>("/boards");
    expect(data).toEqual({ hello: "world" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8080/boards");
    expect(calls[0].init?.method).toBe("GET");
    expect((calls[0].init?.headers as Record<string, string>)?.Accept).toBe("application/json");
  });

  it("apiPost serializes a JSON body and attaches Content-Type", async () => {
    const { calls } = scriptFetch([{ status: 201, body: { id: "t-1" } }]);
    const client = new HttpClient();
    const data = await client.apiPost<{ id: string }>("/tasks", { title: "x" });
    expect(data).toEqual({ id: "t-1" });
    expect(calls[0].url).toBe("http://localhost:8080/tasks");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: "x" }));
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("apiPut sends PUT with the body", async () => {
    const { calls } = scriptFetch([{ status: 200, body: { ok: true } }]);
    const client = new HttpClient();
    await client.apiPut("/tasks/t-1", { title: "y" });
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: "y" }));
  });

  it("apiDelete issues DELETE without a body when none is supplied", async () => {
    const { calls } = scriptFetch([{ status: 200 }]);
    const client = new HttpClient();
    await client.apiDelete("/tasks/t-1");
    expect(calls[0].url).toBe("http://localhost:8080/tasks/t-1");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("apiDelete forwards an optional JSON body", async () => {
    const { calls } = scriptFetch([{ status: 200 }]);
    const client = new HttpClient();
    await client.apiDelete("/tasks/t-1", { reason: "stale" });
    expect(calls[0].init?.body).toBe(JSON.stringify({ reason: "stale" }));
  });

  it("appends query parameters with proper encoding", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const client = new HttpClient();
    await client.apiGet("/boards", { query: { status: "todo", limit: 5, skip: undefined } });
    expect(calls[0].url).toBe("http://localhost:8080/boards?status=todo&limit=5");
  });

  it("respects KANBAN_API_URL for the base URL", async () => {
    process.env.KANBAN_API_URL = "https://kanban.example.com/";
    const { calls } = scriptFetch([{ status: 200, body: {} }]);
    const client = new HttpClient();
    await client.apiGet("/health");
    expect(calls[0].url).toBe("https://kanban.example.com/health");
  });
});

describe("HttpClient bearerToken + 401 retry", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches the bearer token from OAuthClient.loadCredentials()", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      accessToken: "at-fresh",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 60_000,
    });
    const oauth = makeOAuthClient(provider);
    const { calls } = scriptFetch([{ status: 200, body: { ok: 1 } }]);
    const client = new HttpClient();
    client.attachOAuth(oauth);
    await client.apiGet("/boards");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-fresh");
  });

  it("refreshes proactively when the access token is within 5s of expiry", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      accessToken: "at-stale",
      refreshToken: "rt-old",
      accessExpiresAt: Date.now() + 2_000,
    });
    const oauth = makeOAuthClient(provider);
    const { calls } = scriptFetch([
      { status: 200, body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-new" } },
      { status: 200, body: { ok: 1 } },
    ]);
    const client = new HttpClient();
    client.attachOAuth(oauth);
    await client.apiGet("/boards");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(metadataFixture.token_endpoint);
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer at-new");
    expect(provider.read()?.accessToken).toBe("at-new");
  });

  it("retries once after a 401 by refreshing and re-sending the request", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      accessToken: "at-old",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 60_000,
    });
    const oauth = makeOAuthClient(provider);
    const { calls } = scriptFetch([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600 } },
      { status: 200, body: { ok: 1 } },
    ]);
    const client = new HttpClient();
    client.attachOAuth(oauth);
    const data = await client.apiGet<{ ok: number }>("/boards");
    expect(data).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("http://localhost:8080/boards");
    expect(calls[1].url).toBe(metadataFixture.token_endpoint);
    expect(calls[2].url).toBe("http://localhost:8080/boards");
    expect((calls[2].init?.headers as Record<string, string>).Authorization).toBe("Bearer at-new");
  });

  it("raises AuthError when the retry still returns 401", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      accessToken: "at-old",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 60_000,
    });
    const oauth = makeOAuthClient(provider);
    scriptFetch([
      { status: 401 },
      { status: 200, body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600 } },
      { status: 401 },
    ]);
    const client = new HttpClient();
    client.attachOAuth(oauth);
    await expect(client.apiGet("/boards")).rejects.toBeInstanceOf(AuthError);
  });

  it("coalesces concurrent refresh attempts", async () => {
    const provider = new InMemorySecretProvider();
    provider.write({
      apiUrl: "http://localhost:8080",
      clientId: "cid",
      accessToken: "at-stale",
      refreshToken: "rt",
      accessExpiresAt: Date.now() + 1_000,
    });
    const oauth = makeOAuthClient(provider);
    const { calls } = scriptFetch([
      { status: 200, body: { access_token: "at-new", token_type: "Bearer", expires_in: 3600 } },
      { status: 200, body: { ok: 1 } },
      { status: 200, body: { ok: 2 } },
    ]);
    const client = new HttpClient();
    client.attachOAuth(oauth);
    await Promise.all([client.apiGet("/a"), client.apiGet("/b")]);
    const tokenCalls = calls.filter((c) => c.url === metadataFixture.token_endpoint);
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("HttpClient error classification", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps 404 to NotFoundError", async () => {
    scriptFetch([{ status: 404, body: { error: "missing" } }]);
    const client = new HttpClient();
    await expect(client.apiGet("/boards/nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps 500-599 to ServerError", async () => {
    scriptFetch([{ status: 502, body: { error: "bad gateway" } }]);
    const client = new HttpClient();
    await expect(client.apiGet("/x")).rejects.toBeInstanceOf(ServerError);
  });

  it("maps other 4xx to a generic ApiError", async () => {
    scriptFetch([{ status: 418, body: { error: "i am a teapot" } }]);
    const client = new HttpClient();
    const err = await client.apiGet("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err.kind).toBe("unknown");
  });

  it("wraps fetch network failures into NetworkError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new HttpClient();
    const err = await client.apiGet("/x").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toMatch(/network error/i);
  });

  it("preserves status, path, and parsed body on the thrown ApiError", async () => {
    scriptFetch([{ status: 404, body: { error: "missing", id: "t-1" } }]);
    const client = new HttpClient();
    try {
      await client.apiGet("/tasks/t-1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      const api = err as NotFoundError;
      expect(api.status).toBe(404);
      expect(api.path).toBe("/tasks/t-1");
      expect(api.body).toEqual({ error: "missing", id: "t-1" });
    }
  });
});

describe("exitCodeForError", () => {
  it("maps each ApiError subclass to a stable exit code", () => {
    expect(exitCodeForError(new AuthError("x", { path: "/" }))).toBe(2);
    expect(exitCodeForError(new NotFoundError("x", { path: "/" }))).toBe(3);
    expect(exitCodeForError(new ServerError("x", { path: "/" }))).toBe(4);
    expect(exitCodeForError(new NetworkError("x", { path: "/" }))).toBe(5);
    expect(exitCodeForError(new ApiError("unknown", "x", { path: "/" }))).toBe(1);
    expect(exitCodeForError(new Error("other"))).toBe(1);
  });
});