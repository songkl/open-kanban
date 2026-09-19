-- Per-user notification preferences (s-1203, PM_REVIEW_2026-09-17 §3.7).
--
-- The PM review flagged that the notification centre (s-1194) has
-- no per-user opt-out surface: bell-badge rows are written
-- unconditionally and there is no way for a user to mute email /
-- webhook delivery on a per-channel basis. This migration adds a
-- one-row-per-user table so each preference can be flipped
-- independently from a new "Notifications" tab in Settings.
--
-- Columns:
--   user_id           — FK on users.id, PK. ON DELETE CASCADE so
--                       removing a user also drops their prefs row
--                       (we never want orphan rows).
--   email_enabled     — bool, default 1. When 0 the email delivery
--                       path skips the user (the bell badge still
--                       fires — the user can still see the row in
--                       the bell list; email is a separate
--                       transport).
--   webhook_enabled   — bool, default 1. When 0 outbound webhook
--                       deliveries for this user are skipped at the
--                       fan-out layer.
--   webhook_url       — nullable TEXT. Destination for the user's
--                       webhook. When NULL or empty the webhook
--                       fan-out is skipped even if webhook_enabled=1.
--   updated_at        — DATETIME, defaults to now; the PUT handler
--                       stamps it on every successful update so a
--                       future audit page can show "last changed".

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id TEXT PRIMARY KEY,
    email_enabled INTEGER NOT NULL DEFAULT 1,
    webhook_enabled INTEGER NOT NULL DEFAULT 1,
    webhook_url TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
