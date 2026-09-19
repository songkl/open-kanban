-- 006_task_runs_history.down.sql
--
-- Reverse of 006_task_runs_history.up.sql: drop the two history
-- indexes. The schema change in s-1106 (FinishRun no longer
-- DELETEs the row) is intentionally NOT reverted by the down
-- migration — once a deployment starts keeping terminal rows, the
-- application behaviour on rollback would still be "keep the
-- rows" because the migration only touches indexes. Operators
-- who roll back also accept that the accumulated terminal rows
-- remain in place; cleaning them up is a separate manual
-- decision.
--
-- DROP INDEX IF EXISTS mirrors the idempotent shape of 004/005
-- so re-running the down migration is a safe no-op.

DROP INDEX IF EXISTS idx_task_runs_status_finished_at;
DROP INDEX IF EXISTS idx_task_runs_finished_at;