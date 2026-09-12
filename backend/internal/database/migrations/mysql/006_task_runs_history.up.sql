-- 006_task_runs_history.up.sql (MySQL)
--
-- Mirror of the SQLite migration: add two indexes that the v2
-- /api/v1/runs/history endpoint needs once FinishRun / release
-- stop DELETing terminal task_runs rows. See the SQLite version
-- for the full rationale; the same ENGINE/CHARSET/COLLATE
-- declaration is mandatory to match utf8mb4_unicode_ci on the
-- rest of the table (the index columns are DATETIME, so the
-- collation only matters for the table-wide default — but we
-- set it explicitly to keep the same convention as the other
-- MySQL migrations).

CREATE INDEX idx_task_runs_finished_at
    ON task_runs(finished_at);

CREATE INDEX idx_task_runs_status_finished_at
    ON task_runs(status, finished_at);