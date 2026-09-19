# API Changelog

This document tracks changes to the Open-Kanban API specification.

## [Unreleased] — Event Center multi-stage Webhook (s-1156)

### Added

- **Webhook configuration CRUD (s-1143 / s-1156)** — admin
  endpoints to manage outbound webhooks end-to-end:
  - `POST   /api/v1/webhooks` — create a webhook. Body carries
    `name`, `url`, `eventTypes`, `filters`, `headers`,
    `timeoutSec`, `maxRetries`, `enabled`. The response includes
    the redacted `WebhookView` plus a one-shot
    `plaintextSecret` (hex, 64 chars). The plaintext is never
    returned again — subsequent reads return `"********"` for
    the `secret` field. `RequireAuth` + ADMIN role.
  - `GET    /api/v1/webhooks` — list every configured webhook,
    secrets redacted, ordered by `created_at DESC`. `RequireAuth`
    + ADMIN role.
  - `GET    /api/v1/webhooks/:id` — fetch one webhook.
  - `PUT    /api/v1/webhooks/:id` — update mutable fields.
    Secret rotation goes through the dedicated `/rotate`
    endpoint so the audit trail records it as a distinct
    action. `RequireAuth` + ADMIN role.
  - `DELETE /api/v1/webhooks/:id` — remove a webhook; cascades
    into `webhook_deliveries`. `RequireAuth` + ADMIN role.
  - `POST   /api/v1/webhooks/:id/rotate` — mint a fresh 256-bit
    signing secret, return the plaintext exactly once, audit
    `webhook.rotated`. `RequireAuth` + ADMIN role.
  - `GET    /api/v1/webhooks/events` — already shipped in
    s-1154 (event catalogue); listed here so the full
    webhook surface stays in one place.

- **Webhook event catalogue (s-1154)** — `GET /api/v1/webhooks/events`
  returns the fixed, versioned list of 12 webhook events the Event
  Center can emit, including event name, displayName, trigger
  description, simplified JSON Schema subset for the payload
  (type / required / properties), and the §3.2 filter categories
  that apply. The frontend §7.2 event picker renders directly
  from this endpoint so adding a new event is a backend-only
  change. Requires authentication (Bearer or signature).

- **Outbound webhook signing (s-1156)** — every outbound POST
  carries an HMAC-SHA256 signature the receiver can verify with
  the canonical openssl incantation:
  ```
  to_sign   = "<X-Webhook-Timestamp>.<raw_body>"
  signature = hex( HMAC_SHA256(secret, to_sign) )
  Headers:
    X-Webhook-Id:        <webhook.id>
    X-Webhook-Event:     <event.type>
    X-Webhook-Delivery:  <delivery.id>
    X-Webhook-Timestamp: <unix seconds>
    X-Webhook-Signature: sha256=<hex hmac>
  ```
  Receivers reject events whose `X-Webhook-Timestamp` is more
  than 5 minutes off (`replay window`) and recompute the HMAC
  over the raw request body. The signed end-to-end test
  (`backend/internal/services/webhook_e2e_test.go` plus its
  externally-facing mirror in `backend/e2e/webhook_e2e_test.go`)
  asserts byte-for-byte parity with the openssl vector.

- **Retry / exhaustion (s-1156)** — failed deliveries are
  re-attempted with exponential backoff and jitter
  (`delay = min(60s, 2^attempt) + rand(0..1s)`); after
  `webhooks.max_retries` unsuccessful tries the delivery
  transitions to `EXHAUSTED` and stops being picked up. The
  retry sweeper polls every 5 s (`RetrySweepInterval`); the
  end-to-end test in
  `backend/internal/services/webhook_e2e_test.go` (mirrored
  in `backend/e2e/webhook_e2e_test.go`) exercises the
  round-trip against an httptest.Server that always returns
  500.

### Behavior

- **Migration note** — the schema change lands in
  `012_webhook_center` (not `009` as originally drafted — see
  the migration header for the renumber rationale).
  Operators upgrading from a pre-s-1140 build should run
  migrations up to and including 014.
- **Secret rotation is observable** — every write path
  (`webhook.created`, `webhook.updated`, `webhook.deleted`,
  `webhook.rotated`, `webhook.tested`) appends to the existing
  `auth_activity` log so admin changes are traceable.
- **Plaintext secret is returned exactly once** — the
  `plaintextSecret` field is on Create + RotateSecret responses
  only; every other read redacts to `"********"`.

### Behavior — `POST /api/v1/runs/claim` agentType relaxation (s-1161)

- **`agentType` is now optional.** Previously a 400 was
  returned when the body omitted `agentType`. The new behaviour:
  1. Use `agentType` from the body when provided.
  2. Fall back to the calling token's `user_agent` when the
     body omits the field.
  3. If both are empty, write an empty `agent_id` to
     `task_runs` and continue with the claim.

  Clients that already send `agentType` continue to work
  unchanged.
- **The "token `user_agent` must match body `agentType`" 403
  has been removed.** The body value is now honoured verbatim
  so an admin running multiple agent classes can claim on
  behalf of whichever the runner configures without having to
  re-issue tokens. The `user_agent` is still the authoritative
  identity for callers that omit the body field.
- **`FindEligibleTask` skips the `column_agents.agent_types`
  filter entirely when `agentType` is empty**, so a runner
  without an agent class can pick up any eligible task on the
  board. When a column has no `column_agents` row at all the
  query also treats it as "no agent-type restriction" so
  newly added columns still accept claims from existing
  runners.
## Unreleased

### Added

- **Public read-only share link + iframe embed for boards (s-1204, PM_REVIEW_2026-09-17 §6)**
  - `POST /api/v1/boards/{id}/viewer-tokens` - Mint a public,
    read-only viewer token for a board. The plaintext value is
    returned exactly once in the response (`{token}` field); the
    server stores only the SHA-256 hash, same convention as the
    regular `/api/v1/auth/token` endpoint. Authorization is gated
    by `canManageBoardPermissions` (global ADMIN or recorded board
    owner only — share-link management is a meta-capability,
    matching `SetPermission` / `DeletePermission`).
    Body: `{label?, expiresAt?}`. `label` max 200 chars,
    `expiresAt` must be in the future (omit / null = never expires).
  - `GET /api/v1/boards/{id}/viewer-tokens` - List every
    non-revoked token for a board. Plaintext is never returned.
    Authorization mirrors mint.
  - `DELETE /api/v1/boards/{id}/viewer-tokens/{tokenId}` - Soft-
    delete a token. After revoke the public lookup returns 404
    with no leak of whether the token ever existed. Returns 410 if
    the token is already revoked.
  - `GET /api/v1/boards/{id}/viewer-tokens/embed?token=...` -
    Server-rendered iframe snippet the board owner can paste into
    a third-party site. The snippet is built from the request's
    scheme + host so a future route move does not silently break
    embeds already shipped. Requires auth.
  - `GET /api/v1/public/boards/{token}` - Public, read-only board
    read endpoint. Intentionally unauthenticated — gating is done
    by the URL secret alone. Returns a sanitized snapshot
    (`published=false` and `archived=true` tasks are excluded, the
    same filter the regular columns endpoint applies) with
    `readOnly: true` so the client UI can gate itself. Mutation
    endpoints stay protected by `RequireAuth`, so a leaked share
    link never escalates into a write surface.
  - DB migration `013_add_viewer_tokens` adds the `viewer_tokens`
    table (sha256-hashed token, optional expiry, soft-delete
    `revoked_at`, board FK with `ON DELETE CASCADE`, creator FK
    with `ON DELETE SET NULL`).

- **Notifications**
  - `GET /api/v1/auth/me/notification-preferences` - Get the caller's
    per-user notification-delivery preferences. Returns the
    documented defaults (email + webhook enabled, empty webhook URL)
    on first access so the Settings tab never sees a 404.
  - `PUT /api/v1/auth/me/notification-preferences` - Partial update
    of the caller's notification preferences (s-1203,
    PM_REVIEW_2026-09-17 §3.7). Omitted fields are preserved
    server-side. `webhookUrl` must be empty or a valid http(s) URL.

## [1.0.0] - 2026-03-31

### Added

- Initial API specification
- **Authentication**
  - `POST /api/v1/auth/login` - User authentication
  - `POST /api/v1/auth/init` - Server initialization
  - `GET /api/v1/auth/me` - Get current user
  - `GET /api/v1/auth/config` - Get public app configuration
  - `GET /api/v1/auth/token` - List user tokens
  - `POST /api/v1/auth/token` - Create API token
  - `PUT /api/v1/auth/token` - Update token
  - `DELETE /api/v1/auth/token` - Delete token
  - `GET /api/v1/auth/activities` - Activity log
  - `GET /api/v1/auth/agents` - List agents
  - `POST /api/v1/auth/agents` - Create agent
  - `DELETE /api/v1/auth/agents` - Delete agent
  - `POST /api/v1/auth/agents/reset-token` - Reset agent token
  - `GET /api/v1/auth/users` - List users
  - `PUT /api/v1/auth/users` - Update user
  - `POST /api/v1/auth/users/enabled` - Enable/disable user
  - `GET /api/v1/auth/permissions` - List permissions
  - `POST /api/v1/auth/permissions` - Set permission
  - `DELETE /api/v1/auth/permissions` - Delete permission
  - `GET /api/v1/auth/permissions/columns` - Get column permissions
  - `POST /api/v1/auth/permissions/columns` - Set column permission
  - `DELETE /api/v1/auth/permissions/columns` - Delete column permission
  - `PUT /api/v1/auth/config` - Update app config

- **Boards**
  - `GET /api/v1/boards` - List all boards (public)
  - `POST /api/v1/boards` - Create board
  - `GET /api/v1/boards/{id}` - Get board (public)
  - `PUT /api/v1/boards/{id}` - Update board
  - `DELETE /api/v1/boards/{id}` - Delete board (soft delete)
  - `GET /api/v1/boards/{id}/export` - Export board
  - `POST /api/v1/boards/{id}/reset` - Reset board
  - `POST /api/v1/boards/{id}/copy` - Copy board
  - `POST /api/v1/boards/from-template` - Create board from template
  - `POST /api/v1/boards/import` - Import board

- **Columns**
  - `GET /api/v1/columns` - List columns (public)
  - `POST /api/v1/columns` - Create column
  - `PUT /api/v1/columns` - Update column
  - `DELETE /api/v1/columns` - Delete column
  - `PUT /api/v1/columns/reorder` - Reorder columns
  - `GET /api/v1/columns/{columnId}/agent` - Get column agent config
  - `POST /api/v1/columns/{columnId}/agent` - Set column agent config
  - `DELETE /api/v1/columns/{columnId}/agent` - Delete column agent config

- **Tasks**
  - `GET /api/v1/tasks` - List tasks (public)
  - `POST /api/v1/tasks` - Create task
  - `GET /api/v1/tasks/{id}` - Get task (public)
  - `PUT /api/v1/tasks/{id}` - Update task
  - `DELETE /api/v1/tasks/{id}` - Delete task
  - `POST /api/v1/tasks/{id}/archive` - Archive/unarchive task
  - `POST /api/v1/tasks/{id}/complete` - Complete task
  - `GET /api/v1/tasks/{id}/attachments` - Get attachments
  - `GET /api/v1/archived` - List archived tasks
  - `GET /api/v1/drafts` - List draft tasks

- **Comments**
  - `GET /api/v1/comments` - List comments (public)
  - `POST /api/v1/comments` - Create comment
  - `GET /api/v1/comments/{id}` - Get comment (public)

- **Subtasks**
  - `GET /api/v1/subtasks` - List subtasks
  - `POST /api/v1/subtasks` - Create subtask
  - `PUT /api/v1/subtasks/{id}` - Update subtask
  - `DELETE /api/v1/subtasks/{id}` - Delete subtask

- **Templates**
  - `GET /api/v1/templates` - List templates (public)
  - `POST /api/v1/templates` - Save template
  - `DELETE /api/v1/templates/{id}` - Delete template

- **Dashboard**
  - `GET /api/v1/dashboard/stats` - Dashboard statistics

- **Files**
  - `POST /api/v1/upload` - Upload file
  - `DELETE /api/v1/attachments/{id}` - Delete attachment

- **Webhooks**
  - `POST /api/v1/webhook/notify` - Trigger webhook

- **MCP**
  - `GET /api/v1/mcp/my-tasks` - Get agent's tasks

- **System**
  - `GET /api/v1/health` - Health check (public)
  - `GET /api/v1/status` - Status check (public)

### Security

- Bearer token authentication (JWT)
- Optional HMAC-SHA256 signature verification (disabled by default)
- Role-based access control (ADMIN, MEMBER, VIEWER)
- Board-level and column-level permissions

## [1.1.0] - 2026-09-06

### Added

- **Permission cache** — `(user_id, board_id | column_id)` → `access` cache with 5-minute TTL. Avoids a DB roundtrip on every request when the access decision is unchanged. Backend hot-path: `internal/handlers/permission_cache.go`.
- **Permission change immediate effect** — `SetPermission`, `DeletePermission`, `SetColumnPermission`, `DeleteColumnPermission`, `UpdateUser`, `SetUserEnabled` now invalidate `tokenCache` + `permissionCache` for the affected user and resource. The next request reads the new permission state without requiring the user to log out.

### Behavior

- **Board owner short-circuit** — `board_permissions.owner_agent_id` records the user who created the board. `loadBoardAccess` treats that user as ADMIN on the board even if their `users.role` is MEMBER or VIEWER, so the creator can always manage their own board.
- **Column permission overrides board permission** — `column_permissions` row, when present for a `(user_id, column_id)` pair, is authoritative. It does NOT take the max of column vs board access — it simply replaces it. This lets a board owner narrow access on a single sensitive column without revoking the user's board grant.
- **Last admin protection** — `UpdateUser`, `SetUserEnabled`, and `DeleteAgent` call `IsLastAdmin(db, targetUserID)` before committing any change that would leave the system with zero enabled ADMINs. When the target is the last admin, the request is rejected with HTTP 400 and one of:
  - `Cannot demote the last admin`
  - `Cannot disable the last admin`
  - `Cannot delete the last admin`
- **Self enable/disable blocked** — `SetUserEnabled` returns 400 `Cannot enable/disable yourself` when the requester targets their own user ID, to avoid an admin accidentally locking themselves out.
- **Owner cannot self-revoke** — `DeletePermission` refuses to remove a board's owner row (`owner_agent_id == targetUserID`) with 403 `Cannot revoke the board owner's permission`. The board must always have a manageable owner.
- **Permission management is a meta-capability** — `SetPermission` / `DeletePermission` require either `users.role == 'ADMIN'` or `IsBoardOwner(db, user.ID, boardID) == true`. A user who has been granted `ADMIN` access to a board by another admin (without being the recorded owner) cannot manage permissions — they can use the board, but cannot change who else can use it. This is intentional: permission management is reserved to the creator and global admins.

## [1.2.0] - 2026-09-14

### Added

- **Webhook event catalogue (s-1154)** — `GET /api/v1/webhooks/events`
  returns the fixed, versioned list of 12 webhook events the Event
  Center can emit, including event name, displayName, trigger
  description, simplified JSON Schema subset for the payload
  (type / required / properties), and the §3.2 filter categories
  that apply. The frontend §7.2 event picker renders directly
  from this endpoint so adding a new event is a backend-only
  change. Requires authentication (Bearer or signature).

- **External OAuth login (s-1144)** — the `/login` page now renders
  the enabled external identity providers as buttons and exchanges
  the post-callback `?code` for a kanban session. The full
  IdP-side dance (state mint, PKCE, /oauth/external/:slug/login
  redirect, JWKS verification) lands in the sibling s-1145 release;
  this tag ships the public listing endpoint, the login-page UI,
  and the callback `?code` exchange so the front-half of the
  flow can be wired end-to-end without the back-half secrets
  having to ship in the same change.

- **Authentication**
  - `GET /api/v1/auth/external/providers` - List enabled
    external OAuth providers for the /login page. Public
    endpoint, no session required. Returns `[]` (not null)
    when no providers are configured. Each row carries the
    public fields only — `providerId`, `name`, `type`,
    `position`, `clientId`, `scopes`, `authEndpoint` — so the
    encrypted `client_secret` and admin-only audit fields
    cannot leak through the login page render. Ordered by
    `position ASC, created_at DESC` so the admin's
    drag-to-reorder intent survives a public re-fetch.
## [1.2.0] - 2026-09-06

### Added

- **Board ownership transfer** — `POST /api/v1/auth/permissions/transfer-ownership`. Body `{boardId, newOwnerUserId}`. Only the current board owner or a global `ADMIN` can call it. The target user must already have a `board_permissions` row on the board — transferring to a user with no row would leave the board with an owner stamp on a row that does not exist ("无主"). The handler runs in a single transaction:
  - old owner's `owner_agent_id` is cleared (their `access` value is preserved so they remain usable on the board),
  - new owner's row is stamped with `owner_agent_id` and forced to `access = 'ADMIN'`,
  - `tokenCache` + `permissionCache` are invalidated for both users and the resource so the change is visible on the next request.
  - One `PERMISSION_TRANSFER` activity row is written (new `activities.action` value; see migration 005).
- **Activity action `PERMISSION_TRANSFER`** — added by migration `005_extend_activity_actions_transfer` to the `activities.action` CHECK constraint (SQLite + MySQL).
- **Frontend `BoardPermissionsModal` "Transfer Ownership"** — owner / global admin sees a badge with the current owner plus a Transfer button. The transfer dialog lists only users who already have a permission row on the board; backend enforcement remains the source of truth.

### Errors

- `400 Incomplete parameters` — missing `boardId` or `newOwnerUserId`.
- `400 New owner must be different from current owner` — requester tried to transfer to themselves.
- `400 Target user must already have a permission on this board` — new owner has no `board_permissions` row.
- `403 Only admin or board owner can transfer ownership` — caller is neither global admin nor recorded owner.
- `404 Board not found` / `404 Target user not found` — invalid ids.
