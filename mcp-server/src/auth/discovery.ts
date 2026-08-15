// Discovery: fetch the OAuth 2.1 metadata document and JWKS from the kanban
// server so the MCP client can drive the device flow without hardcoded
// endpoints.

import type { OAuthMetadata, JSONWebKeySet } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function discover(apiUrl: string): Promise<OAuthMetadata> {
  const base = apiUrl.replace(/\/+$/, "");
  const url = `${base}/.well-known/oauth-authorization-server`;
  return fetchJSON<OAuthMetadata>(url);
}

export async function fetchJWKS(apiUrl: string): Promise<JSONWebKeySet> {
  const base = apiUrl.replace(/\/+$/, "");
  const url = `${base}/.well-known/jwks.json`;
  return fetchJSON<JSONWebKeySet>(url);
}