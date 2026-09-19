-- 015_task_runs_output.up.sql (MySQL)
--
-- Mirror of the SQLite migration: add a nullable `output`
-- TEXT column to `task_runs` so the CLI runner can
-- persist the agent's stdout (truncated to 64 KiB)
-- alongside the existing `error` column. See the SQLite
-- counterpart for the full rationale; the new column
-- is purely additive and the application-side change in
-- the CLI / handlers ships in the same release.

ALTER TABLE task_runs
    ADD COLUMN output TEXT NULL AFTER error;
