-- Reverse of 004_task_runs.up.sql: drop the task_runs table. MySQL
-- has no DROP INDEX IF EXISTS, so the three supporting indexes fall
-- away with the table. The migration is destructive — any in-flight
-- runner lock rows are lost — but the tasks themselves are untouched.
-- Re-running the up migration recreates the empty table.

DROP TABLE IF EXISTS task_runs;
