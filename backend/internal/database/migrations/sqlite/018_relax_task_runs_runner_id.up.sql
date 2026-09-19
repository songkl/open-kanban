-- 005_relax_task_runs_runner_id.up.sql
--
-- Drop the foreign-key constraint from task_runs.runner_id to
-- users.id. The runner identifier sent over the wire
-- (ClaimRunRequest.RunnerID) is a stable per-process string of the
-- form "hostname-pid-uuid" the CLI generates at startup; it is not
-- the same as a users.id primary key. The original FK forced every
-- claim to store user.ID in runner_id, which in turn made the
-- heartbeat + finish round-trips reject every CLI request that
-- compared against the wire-format runnerId — i.e. the bug only
-- stayed invisible because the handler-level tests owned every
-- runnerId string. Removing the FK keeps the column NOT NULL (we
-- still need a non-empty value to identify the holder) but lets it
-- accept any opaque token, which matches what the CLI sends.
--
-- We rebuild the table with the constraint dropped because SQLite
-- has no ALTER TABLE … DROP CONSTRAINT; the standard recipe is to
-- rename, recreate, copy. The data round-trip is safe because:
--
--   * finished / released rows already carry the runner_id the CLI
--     sent on the wire (some real production installs will have
--     this, others will have user.ID — both are valid history
--     records and we don't try to migrate the values).
--   * The table is recreated with the same column set + indexes;
--     only the runner_id FK is dropped.

PRAGMA foreign_keys = OFF;

CREATE TABLE task_runs_new (
    task_id TEXT PRIMARY KEY,
    runner_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_at DATETIME NOT NULL,
    last_heartbeat_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    finished_at DATETIME,
    exit_code INTEGER,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

INSERT INTO task_runs_new
SELECT task_id, runner_id, agent_id, board_id, column_id, status,
       claimed_at, last_heartbeat_at, expires_at,
       finished_at, exit_code, error
FROM task_runs;

DROP TABLE task_runs;

ALTER TABLE task_runs_new RENAME TO task_runs;

CREATE INDEX IF NOT EXISTS idx_task_runs_expires ON task_runs(expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_runner  ON task_runs(runner_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status  ON task_runs(status);

PRAGMA foreign_keys = ON;
