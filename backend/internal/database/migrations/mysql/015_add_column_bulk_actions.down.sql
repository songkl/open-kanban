-- Reverse of 015_add_column_bulk_actions.up.sql: drop the
-- activities.action CHECK constraint added in the up migration so
-- the BULK_ARCHIVE_COLUMN / BULK_COMPLETE_COLUMN action types can
-- no longer be inserted.
--
-- Mirrors the down migration of 002, 005, and 006 — the latest up
-- migration supersedes the prior CHECK list, so dropping the named
-- constraint restores the constraint-less state of 001.

ALTER TABLE activities DROP CONSTRAINT activities_action_check;
