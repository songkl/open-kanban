// RFC 7591 Dynamic Client Registration.

import type { ClientRegistrationResponse, OAuthErrorResponse, OAuthMetadata } from "./types.js";

export interface RegisterRequest {
  client_name: string;
  grant_types: string[];
  token_endpoint_auth_method: string;
  redirect_uris?: string[];
  scope?: string;
}

export class RegistrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

export async function registerClient(
  metadata: OAuthMetadata,
  request: RegisterRequest
): Promise<ClientRegistrationResponse> {
  if (!metadata.registration_endpoint) {
    throw new RegistrationError("server_error", "AS does not advertise a registration_endpoint");
  }
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  const body = await res.json().catch(() => ({}) as unknown);
  if (!res.ok) {
    const err = body as OAuthErrorResponse;
    throw new RegistrationError(
      err.error || "registration_failed",
      err.error_description || `HTTP ${res.status}`
    );
  }
  return body as ClientRegistrationResponse;
}