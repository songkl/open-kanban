// High-level orchestrator: discovery -> DCR -> device flow -> token storage.
// Designed to be called once at MCP server startup; the resulting TokenManager
// is used by helpers.ts for all subsequent API requests.

import { discover } from "./discovery.js";
import { registerClient, type RegisterRequest } from "./dcr.js";
import {
  requestDeviceCode,
  type TrackedPoll,
  type PollOutcome
} from "./device-flow.js";
import {
  FileSecretProvider,
  InMemorySecretProvider,
  defaultFilePath,
  type SecretProvider,
  type StoredCredentials
} from "./token-store.js";
import type {
  OAuthMetadata,
  TokenResponse
} from "./types.js";

export interface AuthorizeOptions {
  apiUrl: string;
  clientName?: string;
  scope?: string;
  onPrompt?: (poll: TrackedPoll) => Promise<"approve" | "deny">;
  onPoll?: (outcome: PollOutcome) => void;
  secretProvider?: SecretProvider;
  // sleepFn is injectable for tests; defaults to a real setTimeout.
  sleepFn?: (ms: number) => Promise<void>;
}

export class OAuthClient {
  constructor(
    public readonly apiUrl: string,
    public readonly metadata: OAuthMetadata,
    public readonly secretProvider: SecretProvider
  ) {}

  static async fromConfig(opts: AuthorizeOptions): Promise<OAuthClient> {
    const metadata = await discover(opts.apiUrl);
    const provider = opts.secretProvider ?? new FileSecretProvider(defaultFilePath(opts.apiUrl));
    return new OAuthClient(opts.apiUrl, metadata, provider);
  }

  loadCredentials(): StoredCredentials | null {
    const stored = this.secretProvider.read();
    if (!stored) return null;
    if (stored.apiUrl !== this.apiUrl) return null;
    return stored;
  }

  async ensureRegistered(): Promise<StoredCredentials> {
    const existing = this.loadCredentials();
    if (existing?.clientId) return existing;
    const request: RegisterRequest = {
      client_name: "open-kanban-mcp",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      redirect_uris: [],
      scope: this.metadata.scopes_supported?.join(" ") || "kanban:read tasks:write comments:write"
    };
    const reg = await registerClient(this.metadata, request);
    const stored: StoredCredentials = {
      apiUrl: this.apiUrl,
      clientId: reg.client_id,
      scope: reg.scope
    };
    this.secretProvider.write(stored);
    return stored;
  }

  async authorizeInteractive(opts: AuthorizeOptions): Promise<TokenResponse> {
    const creds = await this.ensureRegistered();
    const scope = opts.scope || creds.scope || this.metadata.scopes_supported?.join(" ") || "kanban:read";
    const poll = await requestDeviceCode(this.metadata, creds.clientId, scope);
    if (opts.onPrompt) {
      const choice = await opts.onPrompt(poll);
      if (choice === "deny") {
        throw new Error("user denied authorization");
      }
    }
    return this.pollForToken(creds.clientId, poll, opts);
  }

  async pollForToken(
    clientId: string,
    poll: TrackedPoll,
    opts: AuthorizeOptions
  ): Promise<TokenResponse> {
    const sleep = opts.sleepFn ?? defaultSleep;
    const body = (params: Record<string, string>) =>
      new URLSearchParams(params).toString();
    while (true) {
      if (Date.now() >= poll.expiresAt) {
        throw new Error("device code expired before user approved");
      }
      await sleep(poll.intervalSeconds * 1000);
      let res: Response;
      try {
        res = await fetch(this.metadata.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: poll.deviceCode
          })
        });
      } catch (err) {
        opts.onPoll?.({ status: "error", message: (err as Error).message });
        continue;
      }
      if (res.ok) {
        const tok = (await res.json()) as TokenResponse;
        this.secretProvider.write({
          apiUrl: this.apiUrl,
          clientId,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accessExpiresAt: Date.now() + tok.expires_in * 1000,
          scope: tok.scope || poll.scope
        });
        return tok;
      }
      const errBody = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      const error = (errBody.error || "").toLowerCase();
      if (error === "authorization_pending") {
        opts.onPoll?.({ status: "pending" });
        continue;
      }
      if (error === "slow_down") {
        poll.intervalSeconds += 5;
        opts.onPoll?.({ status: "slow_down" });
        continue;
      }
      if (error === "access_denied") {
        throw new Error("user denied authorization");
      }
      if (error === "expired_token") {
        throw new Error("device code expired");
      }
      throw new Error(errBody.error_description || `token endpoint returned HTTP ${res.status}`);
    }
  }

  async refreshTokens(): Promise<TokenResponse> {
    const stored = this.loadCredentials();
    if (!stored?.refreshToken) {
      throw new Error("no refresh token available");
    }
    const res = await fetch(this.metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: stored.clientId,
        refresh_token: stored.refreshToken
      }).toString()
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      throw new Error(err.error_description || `refresh failed (HTTP ${res.status})`);
    }
    const tok = (await res.json()) as TokenResponse;
    this.secretProvider.write({
      apiUrl: this.apiUrl,
      clientId: stored.clientId,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? stored.refreshToken,
      accessExpiresAt: Date.now() + tok.expires_in * 1000,
      scope: tok.scope || stored.scope
    });
    return tok;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { InMemorySecretProvider, FileSecretProvider, defaultFilePath };
export type { SecretProvider, StoredCredentials };