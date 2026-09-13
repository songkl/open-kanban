-- pending_oauth_states: short-lived CSRF + PKCE state for the
-- external-IdP authorize dance (s-1145, plan §7.1 / §7.2 in
-- docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- MySQL mirror of sqlite/011_oauth_state.up.sql. The engine /
-- collation comment on 009_oauth_providers.up.sql applies here
-- verbatim — every MySQL *.up.sql file in this schema is
-- required to set ENGINE=InnoDB and CHARSET=utf8mb4
-- COLLATE=utf8mb4_unicode_ci, and
-- TestMySQLMigrationsHaveUtf8Mb4Collation fails if a future
-- migration forgets.
--
-- VARCHAR widths mirror the rest of the schema: id at 64
-- (ULID-shaped), the wire-level state / verifier / challenge at
-- 128 (base64url of 64 bytes is 86 chars, leaving headroom for a
-- future bump to 64-byte secrets), provider_id at 64 to match
-- oauth_providers.id, and redirect_after at 2048 so a deep-link
-- like /board/123?task=456&filter=open still fits comfortably.
--
-- The expires_at column is NOT NULL because every callback row
-- must have a TTL — the application layer refuses to insert a
-- row with a zero/NULL expiry, and the DB enforces the
-- invariant too.

CREATE TABLE IF NOT EXISTS pending_oauth_states (
    id              VARCHAR(64) PRIMARY KEY,
    state           VARCHAR(128) NOT NULL UNIQUE,
    provider_id     VARCHAR(64) NOT NULL,
    code_verifier   VARCHAR(128) NOT NULL,
    code_challenge  VARCHAR(128) NOT NULL,
    redirect_after  VARCHAR(2048) NOT NULL DEFAULT '',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME NOT NULL,
    consumed_at     DATETIME,
    CONSTRAINT fk_pending_oauth_states_provider
        FOREIGN KEY (provider_id) REFERENCES oauth_providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_pending_oauth_states_expires ON pending_oauth_states(expires_at);
CREATE INDEX idx_pending_oauth_states_provider ON pending_oauth_states(provider_id);
