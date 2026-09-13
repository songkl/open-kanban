-- webhooks + webhook_deliveries: outbound webhook configuration and
-- delivery log (s-1139, plan §4 in
-- docs/EVENT_CENTER_PLAN_s-1138.md).
--
-- MySQL mirror of sqlite/012_webhook_center.up.sql. The column
-- shape is intentionally identical to the SQLite migration; the
-- differences are:
--
--   * ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
--     COLLATE=utf8mb4_unicode_ci must be explicit on every
--     CREATE TABLE — MySQL 8.0+ defaults to utf8mb4_0900_ai_ci,
--     which collides with the collation on users.id (created in
--     001) and breaks the FK from webhooks.created_by with
--     Error 3780. The same guard TestMySQLMigrationsHaveUtf8Mb4Collation
--     enforces for every MySQL *.up.sql.
--
--   * TINYINT(1) for `enabled` mirrors the convention already
--     used on users.enabled / boards.deleted; MySQL BOOLEAN is
--     an alias for TINYINT(1) and other tables in this schema
--     use the explicit form, so we follow suit.
--
--   * VARCHAR widths: id / FK columns at 64 (ULID-shaped, with
--     headroom matching oauth_clients.id / oauth_device_codes.id
--     / oauth_refresh_tokens.id from migration 001). name at
--     255 matches the rest of the schema for free-form labels;
--     url at 2048 covers any real-world IdP / destination URL
--     comfortably and leaves headroom for a future bump if a
--     tenant ever needs longer URLs.
--
--   * BLOB for `secret` holds the HMAC signing key (32 random
--     bytes per §5.2) — same rationale as oauth_providers.client_secret:
--     (a) the plaintext never lives on disk in a grep-able
--         form,
--     (b) the column won't show up in naive `SELECT *` dumps as
--         a readable string,
--     (c) rotating the cipher length later is a column-level
--         operation without a type change.
--
--   * JSON columns for event_types / filters / headers: MySQL
--     5.7+ has a native JSON type that validates the document
--     and gives us JSON_EXTRACT in queries if the management UI
--     ever wants server-side filtering. The application layer
--     still validates the shape per §3.2 / §7.2 — the DB type
--     is a safety net, not a substitute.
--
--   * VARCHAR(8192) for request_body / response_body lets us
--     retain a generous slice of the round-trip for the
--     deliveries modal (§7.3). The §4 4 KiB response cap is
--     enforced at the API layer; the column is wider so a
--     future bump to the cap is one ALTER TABLE away.
--
--   * The CHECK on delivery.status is the same allow-list as
--     the SQLite mirror so application-side validation can rely
--     on a single source of truth.
--
--   * Indexes on (webhook_id, started_at) and (status, next_retry_at)
--     mirror the SQLite secondary indexes. The ORDER BY
--     started_at DESC in the deliveries query plan uses the
--     (webhook_id, started_at) index; the retry sweeper's
--     `WHERE status='FAILED' AND next_retry_at <= ?` uses the
--     (status, next_retry_at) index — status first because
--     that's the more selective predicate in practice.

CREATE TABLE IF NOT EXISTS webhooks (
    id                  VARCHAR(64) PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    url                 VARCHAR(2048) NOT NULL,
    secret              BLOB NOT NULL,
    enabled             TINYINT(1) NOT NULL DEFAULT 1,
    event_types         JSON NOT NULL,
    filters             JSON NOT NULL,
    headers             JSON NOT NULL,
    timeout_sec         INT NOT NULL DEFAULT 10,
    max_retries         INT NOT NULL DEFAULT 5,
    created_by          VARCHAR(64) NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_success_at     DATETIME NULL,
    last_failure_at     DATETIME NULL,
    CONSTRAINT fk_webhooks_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              VARCHAR(64) PRIMARY KEY,
    webhook_id      VARCHAR(64) NOT NULL,
    event_id        VARCHAR(128) NOT NULL,
    event_type      VARCHAR(64) NOT NULL,
    status          VARCHAR(16) NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED')),
    attempt         INT NOT NULL DEFAULT 1,
    request_body    VARCHAR(8192) NOT NULL DEFAULT '',
    response_code   INT NOT NULL DEFAULT 0,
    response_body   VARCHAR(8192) NOT NULL DEFAULT '',
    error           VARCHAR(1024) NOT NULL DEFAULT '',
    started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME NULL,
    next_retry_at   DATETIME NULL,
    CONSTRAINT fk_webhook_deliveries_webhook
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_webhook_deliveries_webhook_started
    ON webhook_deliveries(webhook_id, started_at);
CREATE INDEX idx_webhook_deliveries_status_next_retry
    ON webhook_deliveries(status, next_retry_at);
