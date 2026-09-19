-- 015_task_runs_output.down.sql
--
-- Reverse of 015_task_runs_output.up.sql: drop the
-- `output` column. SQLite's ALTER TABLE DROP COLUMN is
-- supported since 3.35.0; the in-memory test DBs we use
-- are pinned to a modern build so this is a safe no-op
-- there, and production deployments on the same major
-- release series carry the support too.
--
-- The down migration is destructive — any captured
-- stdout payloads are lost — but the rest of the row
-- (status, exit_code, error, finished_at, …) survives,
-- so the history view still works.

ALTER TABLE task_runs DROP COLUMN output;
