// HTTP client used by the CLI commands.
//
// Responsibilities:
// - Build full URLs against $KANBAN_API_URL (default http://localhost:8080).
// - Attach a Bearer access token sourced from OAuthClient.loadCredentials().
// - Refresh the access token proactively when it expires within 5 seconds.
// - On a 401 response, refresh once and retry exactly once via retryWithRefresh().
// - Map non-2xx responses and network failures to typed ApiError subclasses
//   so the CLI top-level catch can decide an appropriate process exit code.

import { OAuthClient } from "../auth/client.js";
import type { StoredCredentials } from "../auth/token-store.js";

export const DEFAULT_API_URL = "http://localhost:8080";

export type ApiErrorKind = "auth" | "not_found" | "server" | "network" | "unknown";

export interface ApiErrorOptions {
  status?: number;
  path?: string;
  body?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly path: string;
  readonly body?: unknown;

  constructor(kind: ApiErrorKind, message: string, opts: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.path = opts.path ?? "";
    this.body = opts.body;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export class AuthError extends ApiError {
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super("auth", message, { ...opts, status: opts.status ?? 401 });
    this.name = "AuthError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super("not_found", message, { ...opts, status: opts.status ?? 404 });
    this.name = "NotFoundError";
  }
}

export class ServerError extends ApiError {
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super("server", message, { ...opts, status: opts.status ?? 500 });
    this.name = "ServerError";
  }
}

export class NetworkError extends ApiError {
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super("network", message, { ...opts, status: 0 });
    this.name = "NetworkError";
  }
}

export interface HttpClientOptions {
  // apiUrl overrides KANBAN_API_URL / DEFAULT_API_URL for tests and embedders.
  apiUrl?: string;
  // profile is appended to the credential file path via defaultFilePath(appName).
  // The CLI reads KANBAN_CLI_PROFILE so the same user can keep several accounts
  // side-by-side (e.g. "work" vs "personal") without overwriting each other.
  profile?: string;
  // fetchImpl defaults to the global fetch; injectable for tests.
  fetchImpl?: typeof fetch;
  // sleepFn delays between refresh attempts. Injectable for tests.
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  // query is appended to the path as ?key=value (values are stringified).
  query?: Record<string, string | number | boolean | undefined>;
  // extraHeaders lets callers add e.g. Idempotency-Key without re-implementing
  // the auth/error/retry plumbing.
  extraHeaders?: Record<string, string>;
  // signal forwards AbortSignal so commands can be cancelled.
  signal?: AbortSignal;
}

const REFRESH_LEEWAY_MS = 5_000;

export class HttpClient {
  readonly apiUrl: string;
  readonly profile: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private oauthClient: OAuthClient | null = null;
  private refreshPromise: Promise<StoredCredentials | null> | null = null;

  constructor(opts: HttpClientOptions = {}) {
    const envUrl = process.env.KANBAN_API_URL;
    this.apiUrl = (opts.apiUrl ?? envUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.profile = opts.profile ?? process.env.KANBAN_CLI_PROFILE;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
  }

  // attachOAuth wires a client whose loadCredentials() / refreshTokens() drive
  // bearerToken(). Until attached, requests are sent without an Authorization
  // header (matching the public endpoints of the kanban server).
  attachOAuth(client: OAuthClient | null): void {
    this.oauthClient = client;
  }

  // bearerToken returns a still-valid access token, refreshing proactively
  // when the stored one expires within REFRESH_LEEWAY_MS.
  async bearerToken(): Promise<string | null> {
    const client = this.oauthClient;
    if (!client) return null;
    const creds = client.loadCredentials();
    if (!creds?.accessToken && !creds?.refreshToken) return null;
    if (
      creds.accessToken &&
      creds.clientId &&
      (!creds.accessExpiresAt || creds.accessExpiresAt > Date.now() + REFRESH_LEEWAY_MS)
    ) {
      return creds.accessToken;
    }
    const refreshed = await this.ensureRefreshed(client);
    return refreshed?.accessToken ?? creds.accessToken ?? null;
  }

  // retryWithRefresh performs exactly one retry after a 401. If the refresh
  // succeeds but the retry still returns 401, it surfaces an AuthError so the
  // caller can prompt the user to re-authenticate.
  async retryWithRefresh<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    parser: (res: Response) => Promise<T>
  ): Promise<T> {
    const client = this.oauthClient;
    if (!client) {
      throw new AuthError("authentication required", { path });
    }
    await this.ensureRefreshed(client);
    const res = await this.dispatch(method, path, body, await this.bearerToken());
    if (res.status === 401) {
      const payload = await safeJson(res);
      throw new AuthError("authentication failed after token refresh", {
        status: res.status,
        path,
        body: payload,
      });
    }
    return this.handleResponse(res, path, parser);
  }

  async apiGet<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  async apiPost<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  async apiPut<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, body, opts);
  }

  async apiDelete<T = void>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, body, opts);
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    opts: RequestOptions
  ): Promise<T> {
    const fullPath = buildPath(path, opts.query);
    const token = await this.bearerToken();
    let res: Response;
    try {
      res = await this.dispatch(method, fullPath, body, token, opts);
    } catch (err) {
      throw new NetworkError(`network error contacting ${this.apiUrl}${fullPath}`, {
        path: fullPath,
        cause: err,
      });
    }
    if (res.status === 401 && this.oauthClient) {
      return this.retryWithRefresh(method, fullPath, body, (r) => parseJson<T>(r));
    }
    return this.handleResponse(res, fullPath, parseJson<T>);
  }

  private async dispatch(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    token: string | null,
    opts: RequestOptions = {}
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    if (opts.signal) init.signal = opts.signal;
    return this.fetchImpl(url, init);
  }

  private async handleResponse<T>(
    res: Response,
    path: string,
    parser: (res: Response) => Promise<T>
  ): Promise<T> {
    if (res.ok) return parser(res);
    const payload = await safeJson(res);
    throw classifyResponse(res.status, path, payload);
  }

  // ensureRefreshed coalesces concurrent refresh attempts so a burst of
  // expired-token requests triggers at most one round trip to the token endpoint.
  private ensureRefreshed(client: OAuthClient): Promise<StoredCredentials | null> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const tok = await client.refreshTokens();
        return {
          apiUrl: client.apiUrl,
          clientId: client.loadCredentials()?.clientId ?? "",
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accessExpiresAt: Date.now() + tok.expires_in * 1000,
        } satisfies StoredCredentials;
      } catch (err) {
        throw new AuthError(`failed to refresh access token: ${(err as Error).message}`, {
          path: client.metadata.token_endpoint,
          cause: err,
        });
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }
}

function buildPath(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path.startsWith("/") ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return qs ? `${normalized}?${qs}` : normalized;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ApiError("unknown", `failed to parse JSON response: ${(err as Error).message}`, {
      status: res.status,
      path: res.url,
    });
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function classifyResponse(status: number, path: string, body: unknown): ApiError {
  const message = `API error ${status} on ${path}`;
  if (status === 401) return new AuthError(message, { status, path, body });
  if (status === 404) return new NotFoundError(message, { status, path, body });
  if (status >= 500 && status <= 599) return new ServerError(message, { status, path, body });
  if (status >= 400 && status <= 499) return new ApiError("unknown", message, { status, path, body });
  return new ApiError("unknown", message, { status, path, body });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// resolveProfileFromEnv is exported for the bootstrap layer so the CLI's
// top-level commands can show which profile is currently active.
export function resolveProfileFromEnv(): string | undefined {
  return process.env.KANBAN_CLI_PROFILE;
}

// exitCodeForError maps ApiError kinds to POSIX-style exit codes the CLI uses.
// Centralising the mapping keeps the top-level catch in index.ts trivial.
export function exitCodeForError(err: unknown): number {
  if (err instanceof AuthError) return 2;
  if (err instanceof NotFoundError) return 3;
  if (err instanceof ServerError) return 4;
  if (err instanceof NetworkError) return 5;
  if (err instanceof ApiError) return 1;
  return 1;
}