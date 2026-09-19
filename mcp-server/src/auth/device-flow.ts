// RFC 8628 Device Authorization Grant client.

import type { DeviceAuthorizationResponse, OAuthErrorResponse, OAuthMetadata } from "./types.js";

export class DeviceFlowError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

// TrackedPoll exposes the in-flight device flow state so the CLI layer can
// surface it to the user (verification URI + user code).
export interface TrackedPoll {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
  scope: string;
  clientId: string;
  // audienceType is the resolved audience_type the server echoed back.
  // Surfaced so the CLI / MCP server can decide how to interpret the
  // binding (s-1233) — empty string means "no hint, fall back to
  // client-name heuristic".
  audienceType?: string;
}

// DeviceCodeRequestOpts controls optional extensions on the device-code
// request. AudienceType ("agent" | "human") hints to the server which
// identity the resulting token should be bound to; the server applies its
// own client-name heuristic on top and may surface an identity picker on
// the approval page. Unrecognised values are coerced to "human" so callers
// never need to special-case the absence of the field.
export interface DeviceCodeRequestOpts {
  audienceType?: "agent" | "human";
}

export async function requestDeviceCode(
  metadata: OAuthMetadata,
  clientId: string,
  scope: string,
  opts: DeviceCodeRequestOpts = {}
): Promise<TrackedPoll> {
  if (!metadata.device_authorization_endpoint) {
    throw new DeviceFlowError("server_error", "AS does not advertise a device_authorization_endpoint");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    scope
  });
  if (opts.audienceType) {
    body.set("audience_type", opts.audienceType);
  }
  const res = await fetch(metadata.device_authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as OAuthErrorResponse;
    throw new DeviceFlowError(err.error || "request_failed", err.error_description || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as DeviceAuthorizationResponse;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresAt: Date.now() + data.expires_in * 1000,
    intervalSeconds: data.interval,
    scope,
    clientId,
    audienceType: data.audience_type
  };
}

export interface PollOutcome {
  status: "approved" | "pending" | "denied" | "expired" | "slow_down" | "error";
  message?: string;
}

export function asPollOutcome(err: OAuthErrorResponse): PollOutcome {
  switch (err.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", message: err.error_description };
    case "access_denied":
      return { status: "denied", message: err.error_description };
    case "expired_token":
      return { status: "expired", message: err.error_description };
    default:
      return { status: "error", message: err.error_description || err.error };
  }
}