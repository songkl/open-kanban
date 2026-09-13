-- oauth_providers: pluggable external identity-provider registry
-- (s-1140, plan §3.2 in docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- See sqlite/009_oauth_providers.up.sql for the full rationale;
-- the column shape is intentionally identical to the SQLite
-- migration. Differences worth noting:
--
--   * ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
--     COLLATE=utf8mb4_unicode_ci must be explicit — MySQL 8.0+
--     defaults to utf8mb4_0900_ai_ci, which collides with the
--     collation on users.id (created in 001) and breaks the FK
--     from oauth_providers.created_by with Error 3780. Same guard
--     TestMySQLMigrationsHaveUtf8Mb4Collation enforces for every
--     MySQL *.up.sql.
--
--   * TINYINT(1) for `enabled` to mirror the convention already
--     used on users.enabled / boards.deleted; MySQL BOOLEAN is an
--     alias for TINYINT(1) and other tables in this schema use the
--     explicit form, so we follow suit.
--
--   * VARCHAR(255) on the TEXT-shaped columns matches the rest of
--     the schema (oauth_clients uses the same widths). Endpoints /
--     issuer URLs can theoretically exceed 255 chars but real-world
--     IdP URLs do not, and the API layer validates URL length
--     against a 2048-byte budget so a future migration can widen
--     these without a backfill if a tenant ever needs it.
--
--   * BLOB for client_secret holds the AES-256-GCM ciphertext
--     produced by the helper shipping alongside this migration
--     (s-1141). BLOB is the right type because:
--       (a) the plaintext never lives on disk,
--       (b) the column won't show up in naive `SELECT *` dumps as
--           a readable string,
--       (c) rotating the cipher key later is a column-level
--           operation without a type change.
--     Nullable for public-client providers (device flow, PKCE-only)
--     that legitimately have no secret.
--
--   * VARCHAR(64) for the id column matches the convention used by
--     oauth_clients.id / oauth_device_codes.id / oauth_refresh_tokens.id
--     in migration 001 — ULIDs fit in 26 chars, but the rest of the
--     OAuth tables use 64 for headroom.
--
--   * The CHECK on `type` is the same allow-list as the SQLite
--     mirror so application-side validation can rely on a single
--     source of truth.

CREATE TABLE IF NOT EXISTS oauth_providers (
    id                  VARCHAR(64) PRIMARY KEY,
    provider_id         VARCHAR(64) NOT NULL UNIQUE,
    name                VARCHAR(255) NOT NULL,
    type                VARCHAR(32) NOT NULL CHECK(type IN (
        'google', 'github', 'wecom', 'feishu', 'dingtalk', 'oidc'
    )),
    enabled             TINYINT(1) NOT NULL DEFAULT 1,
    position            INT NOT NULL DEFAULT 0,
    client_id           VARCHAR(255) NOT NULL,
    client_secret       BLOB NULL,
    scopes              VARCHAR(1024) NOT NULL DEFAULT '',
    auth_endpoint       VARCHAR(2048) NOT NULL DEFAULT '',
    token_endpoint      VARCHAR(2048) NOT NULL DEFAULT '',
    userinfo_endpoint   VARCHAR(2048) NOT NULL DEFAULT '',
    issuer              VARCHAR(2048) NOT NULL DEFAULT '',
    extra_config        TEXT NOT NULL,
    created_by          VARCHAR(64) NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_oauth_providers_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_providers_enabled ON oauth_providers(enabled);
