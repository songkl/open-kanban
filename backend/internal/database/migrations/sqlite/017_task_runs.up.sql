-- task_runs: server-managed per-task lock row used by the CLI runner
-- claim/heartbeat lifecycle (see devDoc/CLI_RUNNER_PLAN_2026-09-12.md
-- §3.3 and §3.4 for the canonical contract).
--
-- One row per task currently held by a runner; the primary key is the
-- task id so the claim handler can use INSERT … ON CONFLICT to either
-- re-claim an expired row or fail-fast on a live lock. The row is
-- snapshot at claim time:
--
--   * column_id — snapshot of where the task came from, used by the
--     reaper (§3.5) to restore the task when the lock expires.
--   * agent_id  — tokens.user_agent of the CLI that holds the lock;
--     surfaces in activity rows so a board viewer can tell *which*
--     runner picked up the task.
--
-- finished_at / exit_code / error stay NULL while the lock is live
-- and are stamped by the completion / failure handlers. The reaper
-- only ever touches rows whose status is 'claimed' or 'running' AND
-- expires_at < now.
--
-- The runner_id FK is ON DELETE SET NULL (matching the "runner
-- account deleted, lock released" intent — the lock row itself is
-- historical, so we don't want CASCADE to destroy it). The task_id
-- FK is ON DELETE CASCADE because a deleted task implies its lock
-- row is meaningless.

CREATE TABLE IF NOT EXISTS task_runs (
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

CREATE INDEX IF NOT EXISTS idx_task_runs_expires ON task_runs(expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_runner  ON task_runs(runner_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status  ON task_runs(status);
