-- Reverse of 009_add_notifications.up.sql. The notifications table
-- is purely additive (no FK from other tables references it), so
-- dropping it loses only the unread state of any users who had
-- pending notifications at rollback time — acceptable for a
-- forward-only schema policy.

DROP INDEX IF EXISTS idx_notifications_user_unread;
DROP INDEX IF EXISTS idx_notifications_user_created;
DROP TABLE IF EXISTS notifications;