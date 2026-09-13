# External OAuth — Pluggable Identity Provider Design

**Task**: s-1139 — 规划：OAuth 支持 - 接入其他身份系统登录
**Date**: 2026-09-13
**Status**: Design plan (awaiting sub-task creation)
**Depends on**: existing self-hosted OAuth 2.1 server (`backend/internal/oauth/`)
and the Phase 5 stub at `backend/internal/oauth/external.go`

---

## 1. Hard Requirement

> Open-Kanban MUST accept first-time and returning-user logins through
> one or more pluggable external identity providers (Google, GitHub,
> WeCom, Feishu, DingTalk, generic OIDC, …) on top of the existing
> username/password auth; providers and their credentials MUST be
> configurable through an **admin-only** backend surface, credentials
> MUST be encrypted at rest, and **only users with role `ADMIN` may
> create / update / disable / delete a provider configuration**.

Why:

- **Onboarding.** Self-hosted installs today require an out-of-band
  bootstrap (the `POST /api/v1/auth/init` flow) for the very first
  admin. Enterprise deployments want to skip that bootstrap entirely
  and let users sign in with a corporate IdP.
- **Coexistence.** The legacy username/password flow already serves
  self-hosted single-user installs and must keep working — disabling
  it is an operator choice, not a default.
- **Multi-tenant.** A single kanban deployment may federate users
  from multiple IdPs (e.g. one corporate OIDC issuer plus a public
  GitHub org). The design must allow N providers, not just one.
- **Audit.** Every provider configuration change must be traceable
  to an admin account and timestamped.

The hard requirement is implemented at the **schema layer** (new
`oauth_providers` + `user_identities` tables in migration 009) and at
the **handler layer** (`/api/v1/admin/oauth/providers/*` for admin
config; `/api/v1/auth/external/*` and `/oauth/external/*` for the
public IdP dance).

---

## 2. Current State (as of 2026-09-13)

### 2.1 Self-hosted OAuth 2.1 server (already shipped)

`backend/internal/oauth/` implements an OAuth 2.1 / RFC 7591 / RFC 8628
authorization server that **issues** kanban tokens to first-party
clients (the `kanban` CLI uses the device flow). It is the source of
truth for `/oauth/token`, `/oauth/device/code`, `/oauth/register`,
the JWKS endpoint, and `app_config` keys such as `oauth_enabled`.

### 2.2 Phase 5 stub — `external.go`

`backend/internal/oauth/external.go` (54 lines) is a deliberately
empty placeholder that names a roadmap:

1. `user_identities` table for provider/subject/user binding,
2. `app_config` keys for one external provider,
3. `/oauth/external/authorize` + `/callback` to proxy the IdP dance,
4. Provision-on-first-sight for new external users,
5. Optional toggle to disable legacy `/auth/login` + `/auth/init`.

The stub hard-codes a **single** provider. The present plan replaces
that roadmap with a pluggable, N-provider registry while preserving
all five roadmap goals.

### 2.3 Frontend login surface today

`frontend/src/pages/LoginPage.tsx` renders the username + password
form. `frontend/src/components/OAuthSettings.tsx` already exists for
admin OAuth settings (the self-hosted server toggles) and is the
natural host for the new provider-management tab.

### 2.4 Admin role enforcement

`backend/internal/handlers/permission_helper.go:12` exposes
`isAdmin(user)`; every existing admin endpoint (user CRUD, board
ownership, activity log, column permissions) routes through it. The
new provider endpoints reuse the same helper — no new role machinery.

---

## 3. Provider Architecture

### 3.1 Supported provider kinds (v1)

| `kind` | Protocol | Identity claim | Endpoints |
|---|---|---|---|
| `google` | OIDC | `sub` (issuer = `https://accounts.google.com`) | Google discovery |
| `github` | OAuth 2.0 | `id` (no OIDC) | hard-coded |
| `wecom` | OAuth 2.0 (corp) | `userid` | configurable per corp |
| `feishu` | OAuth 2.0 | `union_id` (preferred) or `open_id` | configurable per app |
| `dingtalk` | OAuth 2.0 | `unionid` | configurable per app |
| `oidc` | OIDC | `sub` (issuer-driven discovery) | discovery URL |

`kind` is the row discriminator; the runtime dispatch table lives in
`backend/internal/oauth/providers/<kind>.go` so adding a new provider
is one new file plus a registration line — no edits to the routing
or admin UI.

### 3.2 Data model — `oauth_providers` (migration 009)

```sql
CREATE TABLE oauth_providers (
    id              TEXT PRIMARY KEY,                -- ULID
    kind            TEXT NOT NULL,                   -- google|github|wecom|feishu|dingtalk|oidc
    slug            TEXT NOT NULL UNIQUE,            -- url-safe id, used in /oauth/external/<slug>/...
    display_name    TEXT NOT NULL,                   -- shown on login page
    enabled         INTEGER NOT NULL DEFAULT 1,     -- 0|1, soft kill-switch
    position        INTEGER NOT NULL DEFAULT 0,     -- render order on login page
    client_id       TEXT NOT NULL,                   -- public, may surface in UI tooltips
    client_secret   BLOB NOT NULL,                   -- AES-GCM ciphertext (see §6.2)
    scopes          TEXT NOT NULL DEFAULT '',        -- space-separated
    auth_url        TEXT NOT NULL DEFAULT '',        -- explicit override; empty = use kind default
    token_url       TEXT NOT NULL DEFAULT '',
    userinfo_url    TEXT NOT NULL DEFAULT '',
    issuer          TEXT NOT NULL DEFAULT '',        -- OIDC only
    extra_config    TEXT NOT NULL DEFAULT '{}',      -- JSON, kind-specific (e.g. corp_id for WeCom)
    created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(kind, slug)
);
CREATE INDEX idx_oauth_providers_enabled ON oauth_providers(enabled);
```

`client_secret` is stored as a `BLOB` so we can rotate the cipher
key later without an ALTER TABLE; the plaintext never lives on disk.

### 3.3 Data model — `user_identities` (migration 009)

```sql
CREATE TABLE user_identities (
    id              TEXT PRIMARY KEY,                -- ULID
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id     TEXT NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL,                   -- IdP-side stable id
    raw_claims      TEXT NOT NULL DEFAULT '{}',      -- JSON snapshot of last IdP response
    linked_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider_id, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);
```

Properties:

| Property | Value | Reason |
|---|---|---|
| Nullable on `users` | n/a — identity is a child row | A user may have zero external identities (password-only) or N. |
| FK target | `users(id) ON DELETE CASCADE` | Deleting the local user wipes their IdP bindings (GDPR parity). |
| Unique | `(provider_id, subject)` | One local user per IdP subject — the binding is identity. |
| `raw_claims` | JSON snapshot | Lets us re-extract nickname/avatar when those fields drift, without an extra IdP round-trip on every login. |

---

## 4. Authentication Flow

### 4.1 Standard OIDC / OAuth 2.0 Authorization Code with PKCE

```
Browser                Kanban                  IdP
  │                      │                       │
  │  GET /login          │                       │
  │ ───────────────────▶ │                       │
  │  ◀── HTML (IdP list) │                       │
  │                      │                       │
  │  click "Sign in with Google"                   │
  │ ──────────────────────────────────────────────▶│
  │                      │                       │
  │  GET /oauth/external/google/callback?code=…&state=…
  │ ───────────────────▶ │                       │
  │                      │  POST /token (code+verifier)
  │                      │ ─────────────────────▶ │
  │                      │  ◀── id_token / access_token
  │                      │                       │
  │                      │  GET /userinfo (or verify id_token)
  │                      │ ─────────────────────▶ │
  │                      │  ◀── {sub, email, name, picture}
  │                      │                       │
  │                      │  map(sub) → user_identities row
  │                      │  ├─ hit   → log user in, mint kanban session
  │                      │  └─ miss  → provision new user (see §5), then log in
  │                      │                       │
  │  ◀── 302 /kanban?token=…  (kanban session token)
```

### 4.2 Endpoints (public, no `RequireAuth`)

| Method + Path | Purpose |
|---|---|
| `GET /oauth/external/:slug/login` | Generate `state` (32-byte random, stored in signed cookie + DB row with 10-min TTL) and `code_verifier` (PKCE), redirect to IdP `auth_url`. |
| `GET /oauth/external/:slug/callback` | Verify `state`, exchange `code` + `verifier` for tokens, call `userinfo_url` (or validate `id_token`), map `sub` → user, mint session. |
| `GET /api/v1/auth/external/providers` | Returns the enabled providers for the login page (display name, slug, kind, position). **Public** so `/login` can render before any user is authenticated. |

### 4.3 Coexistence with existing login

The legacy `/api/v1/auth/login` (username + password) and
`/api/v1/auth/init` (first-admin bootstrap) remain untouched. New
admin setting `auth_external_required` (default `0`):

- `0` (default) — both flows are available; the login page renders
  the external provider buttons **above** the password form.
- `1` — password login is hidden on `/login`; init flow is still
  reachable for one bootstrap admin if **no** users exist, then locked
  out. This is the "corporate-only" mode.

The first-admin bootstrap via `/auth/init` MUST remain reachable on a
fresh database even when `auth_external_required=1`, otherwise an
empty deployment with a misconfigured IdP is bricked.

### 4.4 First-login vs. returning-user

| Scenario | Behaviour |
|---|---|
| No matching `user_identities` row, `email_verified=true` on IdP claim, email matches an existing local user | Bind identity to that user; refuse if local user is disabled or is an `AGENT` (agents must not log in via external IdP). |
| No matching row, no email match | Provision a new local user: `type=HUMAN`, `role=USER` (configurable `default_role` per provider, default `USER`), `nickname` = IdP display name (fallback: email local part), `avatar` = IdP picture URL, `enabled=1`. |
| Matching row exists | Reuse the bound `user_id`, refresh `last_used_at` and `raw_claims`. |

The `link-existing` flow (currently-bound email + explicit confirmation
through a re-login form) is **not** in scope for v1 — we auto-link by
verified email. A future `T-XXXX` can add a `linking_mode=manual`
provider config for tenants that want explicit consent.

---

## 5. User Mapping & Provisioning

### 5.1 Field mapping

| Local `users` field | Source | Notes |
|---|---|---|
| `id` | generated ULID | Stable across re-logins. |
| `type` | always `HUMAN` | AGENT identities cannot bind external IdPs. |
| `role` | per-provider `default_role` (`USER` default, can be `ADMIN` for the bootstrap provider) | Configurable in `oauth_providers.extra_config.default_role`. |
| `nickname` | IdP `name` → `preferred_username` → email local part | Truncated to 50 chars; collision suffixes with `-2`, `-3`, … |
| `email` | IdP `email` claim (when verified) | Stored in a new `users.email` column added by migration 009. |
| `avatar` | IdP `picture` claim, if present | Cached locally; refreshed on each login if the URL changes. |
| `password` | random 32-byte, bcrypt-hashed, marked as unusable | External-only accounts never type a password, but the column is NOT NULL on the existing schema. |
| `enabled` | `1` for fresh provision; unchanged for re-bind | Admin can later disable. |
| `created_by` | `oauth_providers.created_by` (the admin who configured the provider) | Traceable. |

### 5.2 Multiple IdPs per local user

A user may have **N** rows in `user_identities` (one per provider).
Deletion of any one row leaves the others intact and does not touch
the local user. The login route looks up by `(provider_id, subject)`
uniquely — there is no ambiguity.

### 5.3 Sync on every login

Each successful external login refreshes the cached fields:

- `nickname`, `avatar`, `email` if the IdP returns a different value.
- `last_used_at` on the `user_identities` row.

Operators may opt out of nickname sync via provider config
(`sync_profile=0`, default `1`) for tenants where the local nickname
is authoritative.

---

## 6. Configuration Management (Admin-only)

### 6.1 Admin endpoints (all behind `RequireAuth(db)` + `isAdmin(user)`)

| Method + Path | Purpose |
|---|---|
| `GET /api/v1/admin/oauth/providers` | List all configured providers (with redacted secrets). |
| `POST /api/v1/admin/oauth/providers` | Create a new provider. Body validated against `kind`. |
| `GET /api/v1/admin/oauth/providers/:id` | Fetch one provider (secret still redacted). |
| `PUT /api/v1/admin/oauth/providers/:id` | Update (any field incl. `enabled` and `client_secret`). |
| `DELETE /api/v1/admin/oauth/providers/:id` | Hard delete + cascade `user_identities`. Refuses if any user is bound unless `?force=1` is also passed (then bound users become password-only). |
| `POST /api/v1/admin/oauth/providers/:id/test` | Round-trip a synthetic `code` flow against the configured endpoints and return the IdP's `userinfo` response (without persisting anything). |

All endpoints write a row to `admin_audit_log` (see §6.4).

### 6.2 Credential encryption at rest

- Master key from env var `OAUTH_PROVIDER_ENCRYPTION_KEY` (32-byte
  hex); if unset, the server **refuses to start** rather than fall
  back to plaintext (fail-closed).
- Cipher: AES-256-GCM with a per-row random 12-byte nonce prefixed to
  the ciphertext. Key rotation: store the new key as
  `OAUTH_PROVIDER_ENCRYPTION_KEY_NEXT`; on next read, transparently
  re-encrypt with the new key.
- The admin UI never receives the plaintext `client_secret` over the
  wire after creation — only a `secret_set: true/false` flag plus the
  `slug`. Re-entry is the only way to change it.

### 6.3 Env-var overrides

For deployments where the admin does not want to use the UI (e.g.
container images), the following env vars seed the DB on startup:

```
OAUTH_EXTERNAL_PROVIDERS=<json-array>
# example:
# [{"kind":"google","slug":"google","displayName":"Google","enabled":true,"clientId":"…","clientSecret":"…","scopes":"openid email profile"}]
```

`EnsureDefaults` (existing helper, `backend/internal/oauth/config.go`)
is extended to seed from this env var on every startup **only if the
slug does not yet exist**. UI edits always win.

### 6.4 Admin audit log

New table `admin_audit_log` (migration 009):

```sql
CREATE TABLE admin_audit_log (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,        -- oauth_provider.create|update|delete|test|enable|disable
    target_id   TEXT,                  -- provider id, nullable
    details     TEXT NOT NULL DEFAULT '{}', -- JSON: changed fields, old vs new (secrets redacted)
    ip          TEXT NOT NULL DEFAULT '',
    ua          TEXT NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_admin_audit_log_actor ON admin_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_target ON admin_audit_log(target_id, created_at DESC);
```

The activity log view (`frontend/src/pages/ActivityLogPage.tsx`) gets
a filter to show only `oauth_provider.*` rows; non-admins still see
their own activity, admins see the full table.

### 6.5 Enable / disable

- `enabled=0` short-circuits both `/oauth/external/:slug/login` (404)
  and the public `/api/v1/auth/external/providers` listing (omit).
- Disabling does not delete; re-enabling restores the row verbatim.
- A provider whose IdP returns 4xx on every callback for 24h logs a
  warning to the activity log but stays `enabled` — admin decides.

---

## 7. Security Considerations

### 7.1 CSRF — `state` parameter

- 32-byte random, base64url-encoded, generated server-side per
  `/login` hit and stored in both an `HttpOnly Secure SameSite=Lax`
  cookie (`oauth_ext_state`, 10-min TTL) and a `pending_oauth_state`
  DB row.
- On callback, both values must match; mismatched ⇒ 400 + clear
  cookie + audit log row.

### 7.2 PKCE

- `code_verifier` = 43-char base64url random; `code_challenge` =
  base64url(SHA-256(verifier)).
- Required for `oidc` and `google`; WeCom/Feishu/DingTalk/GitHub are
  configured per-provider in `extra_config.require_pkce` (default
  `true`; WeCom is `false` because it does not support PKCE on its
  app-authorize endpoint).

### 7.3 Token storage and refresh

- We do **not** persist IdP access/refresh tokens — the only thing
  we keep is the bound `user_id` and a snapshot of the `userinfo`
  claims.
- Every login re-exchanges the auth code. There is no background
  refresh; staleness is bounded by the `state` cookie TTL.
- The kanban session token (issued on successful mapping) follows the
  same rules as `/auth/login` today: opaque, bcrypt-stored server-side,
  TTL governed by `oauth_access_token_ttl_seconds`.

### 7.4 IdP response validation

- For OIDC providers: verify `id_token` signature against the IdP's
  JWKS (cached for 1h), verify `iss` matches `oauth_providers.issuer`,
  verify `aud` matches `client_id`, verify `exp` + `nbf`.
- For non-OIDC (GitHub, WeCom, DingTalk): verify the access token by
  calling `userinfo_url` and require a 2xx + non-empty `id` field.
- All IdP responses are passed through `strings.ToValidUTF8` and
  length-capped to 64 KiB before being JSON-encoded into
  `user_identities.raw_claims` (CLAUDE.md WebSocket-safety rule).

### 7.5 Malicious provider config

- Admin UI validates `auth_url` / `token_url` / `userinfo_url`
  against an allow-list of schemes (`https` only, except `http` for
  `localhost` / `127.0.0.1` to ease self-hosted testing).
- `issuer` must be a valid URL; `scopes` must be a space-separated
  list of `[a-z0-9._:-]{1,64}` tokens.
- Any provider write that fails these checks returns 400 with the
  offending field name; no DB row is created.

### 7.6 Logout

- `/api/v1/auth/logout` (existing) drops the kanban session and the
  cookie. RP-initiated logout to the IdP is **not** wired in v1 —
  the kanban session is what we control; the IdP session lifetime is
  the IdP's problem. A future task can add an optional
  `end_session_url` per provider for tenants that require it.

---

## 8. Implementation Task Breakdown

The work splits into eight sub-tasks, each independently shippable
and testable. Dependencies run top-down; later tasks can start in
parallel only after their deps are merged.

| # | Sub-task ID | Title | Scope |
|---|---|---|---|
| 1 | T-XXXX | DB: `oauth_providers` + `user_identities` + `admin_audit_log` (migration 009, sqlite + mysql) | Schema + indexes + down migrations |
| 2 | T-XXXX | Security: AES-256-GCM `client_secret` encryption helper + env-var `OAUTH_PROVIDER_ENCRYPTION_KEY` | Pure helper package + tests |
| 3 | T-XXXX | Backend: admin CRUD API for `oauth_providers` (admin-only, audit-logged) | Handlers + tests, gated by `RequireAuth` + `isAdmin` |
| 4 | T-XXXX | Backend: external IdP flow (`/oauth/external/:slug/login`, `/callback`, `state` store, PKCE, token exchange, JWKS verification) | New `providers/<kind>.go` files + tests |
| 5 | T-XXXX | Backend: user mapping + provisioning (auto-link by verified email, fresh provision, multi-IdP binding) | Handler + tests |
| 6 | T-XXXX | Frontend: admin OAuth providers tab (list / create / edit / delete / test) | New component, dark-mode-aware |
| 7 | T-XXXX | Frontend: login page external-provider buttons + post-callback landing | `LoginPage.tsx` + i18n strings |
| 8 | T-XXXX | Docs: extend `docs/PERMISSION_MATRIX.md`, add ops guide, update `docs/API_CHANGELOG.md` and `CHANGELOG.md` | Docs only |

Out-of-scope for v1 (recorded for backlog):

- Per-user `linking_mode=manual` (explicit consent flow).
- RP-initiated IdP logout.
- SAML 2.0 (different protocol, separate plan).
- Just-in-time group / role mapping from IdP claims.

---

## 9. Test Plan

Required unit tests per sub-task (CLAUDE.md §"Feature Development"):

- **Schema (1)**: migration round-trip on SQLite + MySQL; uniqueness
  on `(kind, slug)` and `(provider_id, subject)`; FK cascade behaviour.
- **Crypto (2)**: round-trip encrypt/decrypt; tampered ciphertext
  rejected; nonce uniqueness over 10k rows.
- **Admin API (3)**: 403 for non-admin, 200 for admin; redacted
  `client_secret` on every response; audit row written for every
  successful write; invalid URL rejected.
- **IdP flow (4)**: mocked IdP HTTP server; valid code → 302 with
  session; bad state → 400; replayed state → 400; missing PKCE for
  `google` → 400; tampered `id_token` → 401.
- **Provisioning (5)**: fresh provision path; auto-link by verified
  email; refuse to bind to disabled user; refuse to bind to AGENT;
  multi-IdP binding (one user, two identities).
- **Frontend (6/7)**: RTL coverage for the admin form (create +
  edit + delete + test) and the login page (renders providers, posts
  to the correct endpoint, hides on 401).
- **Audit log**: every admin write emits exactly one row with the
  expected `action` + redacted `details`.

Integration coverage: extend `e2e-debug/` with one scenario per
provider kind (using a recorded IdP fixture), gated behind a
`OAUTH_EXTERNAL_E2E=1` env var so it stays out of the default run.

---

## 10. Rollout

1. Ship schema (1) + crypto (2) + admin CRUD (3) behind a feature
   flag `oauth_external_admin_enabled` (default `0`). Admins can
   configure providers in the DB but no public endpoint exists yet.
2. Ship IdP flow (4) + provisioning (5) behind
   `oauth_external_login_enabled` (default `0`). Internal dogfood on
   Google + generic OIDC.
3. Ship frontend (6/7) once both backend halves are stable.
4. Flip both flags to `1` in the next minor release; keep the env-var
   seeding path for containerised deployments.

No database backfill is required (no existing tables are touched
besides adding the nullable `users.email` column).

---

## 11. References

- `backend/internal/oauth/external.go` — Phase 5 stub roadmap.
- `backend/internal/oauth/config.go:21` — `DefaultConfig()` registry
  pattern; the admin provider UI follows the same shape.
- `backend/internal/handlers/permission_helper.go:12` —
  `isAdmin(user)` reuse.
- `backend/internal/handlers/auth_handlers.go:22` — `LoginRequest`
  shape; the external callback lands at the same downstream
  session-mint helper.
- `frontend/src/components/OAuthSettings.tsx` — existing admin OAuth
  settings host (self-hosted server toggles). The new providers tab
  is a sibling tab, not a replacement.
- `docs/AGENT_USER_ASSOCIATION_PLAN_s-1137.md` — sibling design
  template.
- `docs/EVENT_CENTER_PLAN_s-1138.md` — sibling design template.