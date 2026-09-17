-- Reverse of 012_add_user_notification_preferences.up.sql.
-- Drops the FK constraint first (so MySQL does not complain about
-- referenced indexes disappearing with the column drop), then the
-- table.

DROP TABLE IF EXISTS user_notification_preferences;
