export interface Comment {
  id: string;
  content: string;
  author: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  taskId?: string;
  commentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  position: number;
  priority: string;
  assignee: string | null;
  meta: Record<string, unknown> | null;
  columnId: string;
  archived: boolean;
  archivedAt: string | null;
  published: boolean;
  agentId: string | null;
  agentPrompt: string | null;
  createdBy: string;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  subtasks: Subtask[];
  _count?: {
    comments?: number;
    subtasks?: number;
  };
}

/**
 * TaskRun mirrors the server-side `task_runs` row (see
 * `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §3.3 and
 * `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml` §TaskRun). The badge
 * endpoint (`GET /api/v1/runs/:taskId`) only ever surfaces the live
 * `claimed` / `running` states — finished rows are normally deleted
 * by the server, so a 404 is the "no active run" signal the UI uses
 * to hide the badge. The history endpoint
 * (`GET /api/v1/runs/history`) instead lists terminal
 * (`completed` / `failed` / `released`) rows that *do* persist,
 * and those rows carry the optional `finishedAt` / `exitCode` /
 * `error` fields below.
 */
export interface TaskRun {
  taskId: string;
  runnerId: string;
  agentId: string;
  boardId: string;
  columnId: string;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'released';
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
}

export interface Column {
  id: string;
  name: string;
  status: string | null;
  position: number;
  color: string;
  boardId?: string;
  description?: string;
  ownerAgentId?: string;
  tasks: Task[];
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  nickname: string;
  avatar: string | null;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  type: 'HUMAN' | 'AGENT';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

export type PermissionAccess = 'READ' | 'WRITE' | 'ADMIN';

export interface Agent extends User {
  tokenCount: number;
}

export interface Token {
  id: string;
  name: string;
  key: string;
  userId: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scopes: string[];
  isFirstParty: boolean;
  createdAt: string;
}

export interface OAuthConsent {
  clientId: string;
  clientName: string;
  scope: string;
  grantedAt: string;
}

export interface OAuthConfigEntry {
  key: string;
  value: string;
  default: string;
  description: string;
}

// Wire shape for /api/v1/oauth/providers (admin CRUD).
// Mirrors backend internal/oauth.AdminOAuthProvider —
// client_secret is intentionally omitted; only the boolean
// secretSet flag is exposed so the form can show whether a
// secret has already been stored. Re-entry is the only way
// to change a stored secret.
export interface OAuthProvider {
  id: string;
  providerId: string;
  name: string;
  type: string;
  enabled: boolean;
  position: number;
  clientId: string;
  secretSet: boolean;
  scopes: string;
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  issuer: string;
  extraConfig: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// Payload for POST /api/v1/oauth/providers. clientSecret is
// optional because some providers (device flow, PKCE-only) are
// public clients.
export interface OAuthProviderCreate {
  providerId: string;
  name: string;
  type: string;
  enabled?: boolean;
  position?: number;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  issuer?: string;
  extraConfig?: string;
}

// Payload for PUT /api/v1/oauth/providers/:id. Every field is
// optional — absent fields keep their stored value. clientSecret
// being absent keeps the stored secret; supplying one overwrites.
export interface OAuthProviderUpdate {
  name?: string;
  type?: string;
  enabled?: boolean;
  position?: number;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  issuer?: string;
  extraConfig?: string;
}

// Wire shape for the public GET /api/v1/auth/external/providers
// endpoint (s-1144). Deliberately narrower than OAuthProvider —
// the /login page only needs the fields required to render the
// external-provider buttons and to build the IdP authorize URL:
// the public handle (providerId), display name, the type
// discriminator, render order, the OAuth client_id, the scopes
// to send to the IdP, and the explicit auth_endpoint override.
//
// Crucially the encrypted client_secret, internal ULID, audit
// fields, and the disabled toggle are NOT surfaced — the public
// endpoint already filters on enabled=1 so a disabled row never
// appears, and a leak of the admin-only fields would defeat the
// point of separating the public shape from the admin shape.
export interface PublicOAuthProvider {
  providerId: string;
  name: string;
  type: string;
  position: number;
  clientId: string;
  scopes: string;
  authEndpoint: string;
}

// Webhook wire shapes — see docs/EVENT_CENTER_PLAN_s-1138.md §7/§8
// and backend/internal/services/webhook_config_service.go.
// eventTypes / filters / headers are JSON-encoded strings (the
// service layer keeps them as TEXT columns so the frontend can
// round-trip them without losing key order). The form dialog
// parses eventTypes as a string[] and filters / headers as a
// Record<string, string> on render, then re-serialises before
// POST/PUT.
export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  eventTypes: string;
  filters: string;
  headers: string;
  timeoutSec: number;
  maxRetries: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}

export interface WebhookCreate {
  name: string;
  url: string;
  eventTypes: string;
  filters: string;
  headers: string;
  enabled?: boolean;
  timeoutSec?: number;
  maxRetries?: number;
}

export interface WebhookUpdate {
  name?: string;
  url?: string;
  eventTypes?: string;
  filters?: string;
  headers?: string;
  enabled?: boolean;
  timeoutSec?: number;
  maxRetries?: number;
}

// Event catalogue entry returned by GET /api/v1/webhooks/events.
// The picker renders this slice directly so adding a new event
// upstream is a backend-only change.
export interface WebhookEventCatalogueEntry {
  event: string;
  displayName: string;
  description: string;
  payloadSchema: Record<string, unknown>;
  filters: string[];
}

// One row of GET /api/v1/webhooks/:id/deliveries. Mirrors the
// backend webhookDeliveryView (handlers/webhooks.go). The modal
// renders whatever fields are present so future additions (e.g.
// rawBody / responseBody) will appear automatically.
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempt: number;
  responseCode: number;
  error?: string;
  startedAt: string;
  finishedAt?: string | null;
  nextRetryAt?: string | null;
}
