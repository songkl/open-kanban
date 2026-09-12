-- 006_task_runs_history.up.sql
--
-- Add the indexes the v2 /api/v1/runs/history endpoint needs to
-- answer "show me completed / failed / released runs for runner X
-- between time A and time B" without scanning the whole
-- `task_runs` table. The application change lands in s-1106 +
-- s-1107: FinishRun / release now keeps the row (status =
-- 'completed' | 'failed' | 'released') instead of DELETE-ing it,
-- so terminal rows accumulate and a covering index on the time
-- column matters.
--
-- We add two indexes:
--
--   * idx_task_runs_finished_at — single-column index on
--     finished_at for the common "last 24h / 7d / 30d" queries.
--   * idx_task_runs_status_finished_at — composite (status,
--     finished_at) so a filtered history query ("completed in the
--     last 7d") can satisfy both predicates from the index without
--     touching the heap for every row.
--
-- The PRIMARY KEY on task_id is still the natural choice for "is
-- this task currently locked?" reads; the new indexes only matter
-- for the history read path and don't conflict with it.
--
-- CREATE INDEX IF NOT EXISTS is the same guard used by 004/005 —
-- SQLite and MySQL both accept it, and re-running the migration is
-- a no-op.

CREATE INDEX IF NOT EXISTS idx_task_runs_finished_at
    ON task_runs(finished_at);

CREATE INDEX IF NOT EXISTS idx_task_runs_status_finished_at
    ON task_runs(status, finished_at);