-- 015_task_runs_output.down.sql (MySQL)
--
-- Reverse of 015_task_runs_output.up.sql: drop the
-- `output` column. See the SQLite counterpart for the
-- rationale; the column is purely additive so the
-- rollback is symmetric.

ALTER TABLE task_runs DROP COLUMN output;
