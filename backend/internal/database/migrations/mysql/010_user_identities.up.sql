-- user_identities: external-IdP to local-user binding
-- (s-1142, plan §3.3 / §5 in docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- MySQL mirror of sqlite/010_user_identities.up.sql. The
-- engine / collation comment on 009_oauth_providers.up.sql
-- applies here verbatim — every MySQL *.up.sql file in this
-- schema is required to set ENGINE=InnoDB and CHARSET=utf8mb4
-- COLLATE=utf8mb4_unicode_ci, and TestMySQLMigrationsHaveUtf8Mb4Collation
-- fails if a future migration forgets.
--
-- Column shape mirrors the SQLite version with the same type
-- widths used by oauth_providers / oauth_clients (id at 64,
-- TEXT-shaped columns at 255 / 1024 / 2048) so a single column
-- inventory covers both backends. raw_claims is TEXT (not JSON)
-- because the column is opaque JSON written and read by Go;
-- MySQL's JSON type adds a server-side validation pass we
-- don't need (the API layer validates the bytes).
--
-- The users.email ALTER TABLE is intentionally NOT NULL: every
-- existing row in production will have NULL until the next
-- callback rewrites it. Forcing NOT NULL would block the
-- migration on databases with pre-existing users; the auto-link
-- path in the callback handler treats NULL and "" identically
-- (no match → fall through to fresh provision) so the
-- non-nullable default is acceptable here.

CREATE TABLE IF NOT EXISTS user_identities (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    provider_id     VARCHAR(64) NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    raw_claims      TEXT NOT NULL,
    linked_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_identities_provider_subject (provider_id, subject),
    CONSTRAINT fk_user_identities_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_identities_provider
        FOREIGN KEY (provider_id) REFERENCES oauth_providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_user_identities_user ON user_identities(user_id);

ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL AFTER nickname;

CREATE INDEX idx_users_email ON users(email);
