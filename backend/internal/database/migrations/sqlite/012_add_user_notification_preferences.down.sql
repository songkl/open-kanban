-- Reverse of 012_add_user_notification_preferences.up.sql.
-- Drops the per-user preferences table added for s-1203. The down
-- migration is allowed to be lossy (existing preference rows are
-- dropped with the table); the rest of the notification surface
-- (the notifications table from migration 009) is untouched.

DROP TABLE IF EXISTS user_notification_preferences;
