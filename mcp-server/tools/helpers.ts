import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClient } from "../src/auth/client.js";
import type { StoredCredentials } from "../src/auth/token-store.js";

const API_BASE = process.env.KANBAN_API_URL || "http://localhost:8080";
const MCP_TOKEN = process.env.KANBAN_MCP_TOKEN;
const MCP_REQUEST_HEADER = "X-MCP-Request";
const BROADCAST_URL = process.env.BROADCAST_URL || "http://localhost:3001/broadcast";

// Lazy OAuthClient holder. Set by setOAuthClient() during index.ts bootstrap.
// When unset, helpers fall back to the legacy KANBAN_MCP_TOKEN env var.
let oauthClient: OAuthClient | null = null;

export function setOAuthClient(client: OAuthClient | null) {
  oauthClient = client;
}

export function getOAuthClient(): OAuthClient | null {
  return oauthClient;
}

async function bearerToken(): Promise<string | null> {
  if (oauthClient) {
    const creds = oauthClient.loadCredentials();
    if (!creds?.accessToken && !creds?.refreshToken) {
      return null;
    }
    if (
      creds.accessToken &&
      (!creds.accessExpiresAt || creds.accessExpiresAt > Date.now() + 5_000)
    ) {
      return creds.accessToken;
    }
    if (creds.refreshToken) {
      try {
        const tok = await oauthClient.refreshTokens();
        return tok.access_token;
      } catch {
        return null;
      }
    }
    return null;
  }
  return MCP_TOKEN ?? null;
}

function authChallenge(res: Response): string | null {
  const header = res.headers.get("www-authenticate");
  return header;
}

async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function retryWithRefresh<T>(
  method: string,
  path: string,
  body: any,
  parser: (res: Response) => Promise<T>
): Promise<T> {
  if (!oauthClient) {
    throw new Error("API unauthorized");
  }
  const tok = await oauthClient.refreshTokens();
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tok.access_token}`,
      [MCP_REQUEST_HEADER]: "true"
    }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const retry = await fetch(`${API_BASE}${path}`, init);
  if (!retry.ok) {
    throw new Error(`API error after refresh: ${retry.status} ${retry.statusText}`);
  }
  return parser(retry);
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = await bearerToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
  });
  if (res.status === 401 && oauthClient) {
    return retryWithRefresh("GET", path, undefined, parseBody<T>);
  }
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText} ${authChallenge(res) ?? ""}`);
  }
  return parseBody<T>(res);
}

export async function apiPost<T>(path: string, body: any): Promise<T> {
  const token = await bearerToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && oauthClient) {
    return retryWithRefresh("POST", path, body, parseBody<T>);
  }
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText} ${authChallenge(res) ?? ""}`);
  }
  return parseBody<T>(res);
}

export async function apiPut<T>(path: string, body: any): Promise<T> {
  const token = await bearerToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && oauthClient) {
    return retryWithRefresh("PUT", path, body, parseBody<T>);
  }
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText} ${authChallenge(res) ?? ""}`);
  }
  return parseBody<T>(res);
}

export async function apiDelete(path: string, body?: any): Promise<void> {
  const token = await bearerToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && oauthClient) {
    await retryWithRefresh("DELETE", path, body, async () => undefined);
    return;
  }
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}

export async function apiDeleteWithResult<T>(path: string, body?: any): Promise<T> {
  const token = await bearerToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && oauthClient) {
    return retryWithRefresh("DELETE", path, body, parseBody<T>);
  }
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return parseBody<T>(res);
}

export async function broadcast() {
  try {
    await fetch(BROADCAST_URL, {
      method: "POST",
      body: JSON.stringify({ type: "refresh" }),
    });
  } catch (e) {
    // API server not running, ignore
  }
}

export function createToolResult(content: string, isError = false): CallToolResult {
  return { content: [{ type: "text" as const, text: content }], isError };
}

export function jsonToolResult(data: any): CallToolResult {
  return createToolResult(JSON.stringify(data, null, 2));
}

export { API_BASE };

export type { OAuthClient, StoredCredentials };