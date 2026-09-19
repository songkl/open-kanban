-- 006_task_runs_history.down.sql (MySQL)
--
-- Reverse of 006_task_runs_history.up.sql: drop the two history
-- indexes. See the SQLite counterpart for the rationale; this is
-- purely a schema/index change so the rollback is symmetric.

DROP INDEX idx_task_runs_status_finished_at ON task_runs;
DROP INDEX idx_task_runs_finished_at ON task_runs;