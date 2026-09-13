-- oauth_providers: pluggable external identity-provider registry
-- (s-1140, plan §3.2 in docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- Each row is one IdP the admin has wired the kanban instance to
-- (Google, GitHub, WeCom, Feishu, DingTalk, generic OIDC, ...). The
-- login page renders the enabled ones; the admin-only
-- /api/v1/admin/oauth/providers CRUD endpoints write here.
--
-- Column rationale:
--
--   * id              — internal ULID primary key. Never surfaced in
--                        URLs or wire formats directly; provider_id
--                        is the public, URL-safe handle.
--   * provider_id     — short, URL-safe, unique per-deployment handle
--                        used as the path segment in
--                        /oauth/external/<provider_id>/login and
--                        /callback. Lowercase letters / digits /
--                        dashes; UNIQUE so the public route can't
--                        collide between providers.
--   * name            — display name shown on the login button
--                        ("Sign in with Google"). Free-form, NOT
--                        UNIQUE so two providers of the same kind
--                        can have different display names
--                        ("GitHub (public)" vs "GitHub (enterprise)").
--   * type            — discriminator for the runtime dispatch table
--                        in backend/internal/oauth/providers/<type>.go.
--                        CHECK constrained so the admin UI / API can
--                        reject typos at INSERT time rather than
--                        discovering them at the first callback.
--   * enabled         — soft kill-switch. enabled=0 hides the row
--                        from GET /api/v1/auth/external/providers and
--                        makes /oauth/external/<provider_id>/login
--                        404. Disable != delete so re-enabling keeps
--                        the row verbatim (including the encrypted
--                        secret).
--   * position        — render order on the login page. Lower wins.
--                        Defaults to 0; the admin UI exposes drag
--                        handles to renumber.
--   * client_id       — the OAuth client_id issued by the IdP. Public,
--                        may appear in tooltips. Not encrypted.
--   * client_secret   — AES-256-GCM ciphertext (12-byte nonce ||
--                        tag || body) produced by the helper that
--                        ships alongside this migration (s-1141).
--                        Stored as BLOB so the column type can't be
--                        casually grep'd for plaintext; nullable for
--                        public-client providers (device flow, PKCE
--                        only) that legitimately have no secret.
--   * scopes          — space-separated scope list (per RFC 6749 §3.3),
--                        e.g. "openid email profile". Validated
--                        against [a-z0-9._:-]{1,64} at the API
--                        layer, NOT here, because per-row regex
--                        validation in SQL is platform-specific.
--   * auth_endpoint   — explicit override for the IdP's authorization
--                        endpoint. Empty string means "use the type's
--                        built-in default" (e.g. Google's well-known
--                        discovery URL). Stored as TEXT NOT NULL
--                        DEFAULT '' so the column is always present
--                        even when the runtime falls back to defaults.
--   * token_endpoint  — explicit override for the token exchange URL.
--                        Same empty-means-default convention.
--   * userinfo_endpoint — explicit override for the userinfo URL.
--                        Same empty-means-default convention. NULL
--                        would be cleaner but breaks "always present
--                        columns" tooling; empty string is the
--                        chosen convention.
--   * issuer          — OIDC issuer identifier. Required when type='oidc'
--                        so the JWKS discovery URL can be derived;
--                        optional for the pre-defined kinds whose
--                        issuer is hard-coded in their provider
--                        implementation.
--   * extra_config    — JSON blob for type-specific knobs (e.g. corp_id
--                        for WeCom, default_role for new users,
--                        require_pkce=false for non-PKCE providers,
--                        sync_profile=0 to disable nickname sync).
--                        Validated at the API layer; the column
--                        itself is opaque JSON text.
--   * created_by      — admin users.id who first configured the
--                        provider. Nullable so the migration is
--                        lossless against rows seeded by
--                        EnsureDefaults from the
--                        OAUTH_EXTERNAL_PROVIDERS env var on
--                        startup (the env-var path doesn't have a
--                        creator to stamp). ON DELETE SET NULL
--                        mirrors the choice on users.created_by:
--                        deleting the admin must not silently
--                        delete every provider they configured.
--   * created_at / updated_at — straight DATETIME stamps; the admin
--                        audit log (s-1143) carries the actor for
--                        each individual change so we don't need
--                        updated_by on this table.
--
-- Indexes:
--   * UNIQUE on provider_id — backs the public route lookup and
--     prevents accidental duplicate handles.
--   * idx_oauth_providers_enabled — backs the public
--     "list enabled providers for the login page" query without a
--     table scan once the admin has many configured but most are
--     disabled.
--
-- This migration ships the schema for the admin CRUD surface (the
-- next sub-task). User mapping (`user_identities`) and admin audit
-- log (`admin_audit_log`) are intentionally separate sub-tasks per
-- the plan's §8 breakdown — adding them here would conflate
-- reviewable units.

CREATE TABLE IF NOT EXISTS oauth_providers (
    id                  TEXT PRIMARY KEY,
    provider_id         TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL CHECK(type IN (
        'google', 'github', 'wecom', 'feishu', 'dingtalk', 'oidc'
    )),
    enabled             INTEGER NOT NULL DEFAULT 1,
    position            INTEGER NOT NULL DEFAULT 0,
    client_id           TEXT NOT NULL,
    client_secret       BLOB,
    scopes              TEXT NOT NULL DEFAULT '',
    auth_endpoint       TEXT NOT NULL DEFAULT '',
    token_endpoint      TEXT NOT NULL DEFAULT '',
    userinfo_endpoint   TEXT NOT NULL DEFAULT '',
    issuer              TEXT NOT NULL DEFAULT '',
    extra_config        TEXT NOT NULL DEFAULT '{}',
    created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oauth_providers_enabled ON oauth_providers(enabled);
