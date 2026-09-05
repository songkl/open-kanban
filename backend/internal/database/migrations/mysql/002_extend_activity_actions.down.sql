-- Reverse of 002_extend_activity_actions.up.sql: drop the
-- activities.action CHECK constraint that was added in the up
-- migration. MySQL 8.0+ uses the auto-generated
-- activities_action_check name for unnamed CHECK clauses added
-- via ADD CONSTRAINT … CHECK (…).

ALTER TABLE activities DROP CONSTRAINT activities_action_check;
