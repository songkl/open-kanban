-- Reverse of 005_extend_activity_actions_transfer.up.sql: drop the
-- activities.action CHECK constraint added in the up migration so
-- the PERMISSION_TRANSFER action type can no longer be inserted.
--
-- MySQL 8.0+ uses the auto-generated activities_action_check name
-- for unnamed CHECK clauses added via ADD CONSTRAINT … CHECK (…).
-- Note that the prior 002 migration also targets the same
-- constraint name, so the down migration is identical to that of
-- 002 — applying both downs in order yields the constraint-less
-- state of 001.

ALTER TABLE activities DROP CONSTRAINT activities_action_check;
