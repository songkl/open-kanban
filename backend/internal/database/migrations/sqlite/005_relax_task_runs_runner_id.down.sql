-- 005_relax_task_runs_runner_id.down.sql
--
-- Reverse of 005_relax_task_runs_runner_id.up.sql: restore the
-- original FK constraint from task_runs.runner_id to users.id. The
-- reverse is destructive — any existing task_runs rows whose
-- runner_id does not match a users.id row are dropped because the
-- FK cannot be added with violating rows present. Operators who
-- care about preserving history should dump the rows before
-- down-migrating.

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
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (runner_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO task_runs_new
SELECT task_id, runner_id, agent_id, board_id, column_id, status,
       claimed_at, last_heartbeat_at, expires_at,
       finished_at, exit_code, error
FROM task_runs
WHERE runner_id IN (SELECT id FROM users);

DROP TABLE task_runs;

ALTER TABLE task_runs_new RENAME TO task_runs;

CREATE INDEX IF NOT EXISTS idx_task_runs_expires ON task_runs(expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_runner  ON task_runs(runner_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status  ON task_runs(status);

PRAGMA foreign_keys = ON;
