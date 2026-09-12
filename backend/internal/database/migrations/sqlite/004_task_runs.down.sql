-- Reverse of 004_task_runs.up.sql: drop the task_runs table and the
-- three indexes it added. The migration is destructive — any
-- in-flight runner lock rows are lost — but the tasks themselves are
-- untouched (no shared rows with the tasks table beyond the FK
-- pointer). Re-running the up migration recreates the empty table
-- and indexes; an operator who wants to preserve history can dump
-- the rows before down-migrating.

DROP INDEX IF EXISTS idx_task_runs_status;
DROP INDEX IF EXISTS idx_task_runs_runner;
DROP INDEX IF EXISTS idx_task_runs_expires;
DROP TABLE IF EXISTS task_runs;
