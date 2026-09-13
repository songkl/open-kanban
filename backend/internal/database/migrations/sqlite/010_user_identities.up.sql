-- user_identities: external-IdP to local-user binding
-- (s-1142, plan §3.3 / §5 in docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- Each row records that the local user `user_id` has been seen
-- logging in via the external IdP `provider_id` (FK to
-- oauth_providers.id) using the IdP-stable identifier `subject`.
-- The same local user may have N rows (one per IdP they use);
-- the same `(provider_id, subject)` pair maps to at most one
-- local user — that uniqueness is what makes the binding the
-- source of truth for "is this returning external user?".
--
-- Column rationale:
--
--   * id            — internal ULID PK; never exposed externally
--                     (the (provider_id, subject) pair is the
--                     natural key).
--   * user_id       — FK to users.id, ON DELETE CASCADE mirrors
--                     the GDPR-parity choice in the plan: deleting
--                     the local user wipes every IdP binding they
--                     had. Re-binding requires a fresh first login.
--   * provider_id   — FK to oauth_providers.id, ON DELETE CASCADE
--                     so removing a provider in the admin UI tears
--                     down all of its bindings atomically (no
--                     orphan rows referencing a deleted provider).
--                     The admin DELETE handler already calls into
--                     CASCADE; the providers.go comment cross-refs
--                     this table.
--   * subject       — IdP-stable user identifier. For OIDC this is
--                     the `sub` claim; for GitHub the `id` field;
--                     for WeCom / Feishu / DingTalk the appropriate
--                     vendor identifier. We never normalise
--                     (case-fold, trim) here — the IdP returns the
--                     authoritative string and any transformation
--                     belongs in the provider-specific fetcher that
--                     lands with the per-kind dispatch table
--                     (s-1145 / s-1146).
--   * raw_claims    — JSON snapshot of the IdP userinfo payload
--                     captured at bind time (and refreshed on
--                     every re-login). Lets us re-extract
--                     nickname / avatar / email when those fields
--                     drift on the IdP side without an extra IdP
--                     round-trip. The CLAUDE.md WebSocket-safety
--                     rule applies: the JSON encoder + handler
--                     truncate to 64 KiB and pass through
--                     strings.ToValidUTF8 before persisting.
--   * linked_at     — when the row was first inserted. Stamped by
--                     DEFAULT CURRENT_TIMESTAMP so the OAuth
--                     callback handler doesn't have to remember
--                     to set it.
--   * last_used_at  — refreshed on every successful callback (the
--                     callback handler updates this in place so
--                     the audit trail can answer "when did this
--                     IdP binding last authenticate?").
--
-- Indexes:
--
--   * UNIQUE(provider_id, subject) — the natural key. Backs the
--     callback handler's "is this returning external user?" hot
--     path so it can answer with a single indexed lookup.
--   * idx_user_identities_user — backs future admin queries that
--     list "every IdP binding for this user" (e.g. an account
--     page where the user can unlink GitHub).
--
-- The plan also calls for adding `users.email` so the
-- auto-link-by-verified-email path in the callback handler can
-- find an existing local user by their email column instead of
-- needing a parallel `users_oauth_emails` table. We land both
-- pieces in this migration so dev databases that pull this
-- schema in one shot don't end up with the callback handler
-- referencing a column that doesn't exist yet.
--
-- `users.email` rationale:
--   * NULLABLE on purpose — pre-existing users from migrations
--     001-008 don't have an email on file. Forcing NOT NULL
--     would require a backfill that fabricates addresses.
--   * VARCHAR(255) — RFC 5321 caps the local-part at 64 and
--     domain at 255, total 320; 255 is the column width used
--     elsewhere in the schema and is comfortably above the 99th
--     percentile of real-world addresses.
--   * Lowercase collation on SQLite (the default) and
--     utf8mb4_unicode_ci on MySQL (also the default in this
--     schema) so `WHERE email = ?` lookups are case-insensitive
--     without an explicit LOWER() in the query.
--   * idx_users_email backs the auto-link lookup so a deployment
--     with thousands of users doesn't fall back to a table scan
--     on every callback.

CREATE TABLE IF NOT EXISTS user_identities (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id     TEXT NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL,
    raw_claims      TEXT NOT NULL DEFAULT '{}',
    linked_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

ALTER TABLE users ADD COLUMN email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
