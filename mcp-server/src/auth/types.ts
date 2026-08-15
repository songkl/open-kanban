// OAuth 2.1 client types used by the MCP server. These mirror the subset of
// RFC 7591 / RFC 6749 / RFC 8628 fields the kanban server exposes.

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  jwks_uri: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  grant_types_supported: string[];
  response_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface JSONWebKey {
  kty: string;
  use?: string;
  alg?: string;
  kid?: string;
  n?: string;
  e?: string;
}

export interface JSONWebKeySet {
  keys: JSONWebKey[];
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  redirect_uris?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  client_name?: string;
}