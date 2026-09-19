-- Reverse of 006_add_bulk_permission_action.up.sql: drop the
-- activities.action CHECK constraint added in the up migration so
-- the PERMISSION_BULK_GRANT action type can no longer be inserted.
--
-- MySQL 8.0+ uses the auto-generated activities_action_check name
-- for unnamed CHECK clauses added via ADD CONSTRAINT … CHECK (…).
-- This is identical to the down migration of 002 and 005 — the
-- three up migrations each add their own activities_action_check
-- (the later one supersedes the earlier one), and dropping it
-- restores the constraint-less state of 001.

ALTER TABLE activities DROP CONSTRAINT activities_action_check;
