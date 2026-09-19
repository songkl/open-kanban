-- Per-user notification preferences (s-1203, PM_REVIEW_2026-09-17 §3.7).
--
-- The PM review flagged that the notification centre (s-1194) has
-- no per-user opt-out surface: bell-badge rows are written
-- unconditionally and there is no way for a user to mute email /
-- webhook delivery on a per-channel basis. This migration adds a
-- one-row-per-user table so each preference can be flipped
-- independently from a new "Notifications" tab in Settings.
--
-- MySQL side mirrors the SQLite side in 012_add_user_notification_preferences.up.sql.
-- `email_enabled` / `webhook_enabled` are TINYINT(1) here because
-- that is the convention the rest of the schema already uses for
-- boolean flags (see users.enabled), and an explicit CHECK keeps
-- the column from accepting an arbitrary integer that the Go layer
-- would later have to special-case.

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id VARCHAR(64) NOT NULL,
    email_enabled TINYINT(1) NOT NULL DEFAULT 1,
    webhook_enabled TINYINT(1) NOT NULL DEFAULT 1,
    webhook_url TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_unp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_unp_email_enabled CHECK (email_enabled IN (0, 1)),
    CONSTRAINT chk_unp_webhook_enabled CHECK (webhook_enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
