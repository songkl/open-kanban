-- 005_relax_task_runs_runner_id.down.sql (MySQL)
--
-- Reverse of 005_relax_task_runs_runner_id.up.sql: restore the
-- foreign-key constraint from task_runs.runner_id to users.id.
-- The reverse is destructive — MySQL refuses to add a FK if any
-- existing row violates it, so we first DELETE the offending rows
-- (those whose runner_id does not match any users.id) and only
-- then add the constraint back.

DELETE FROM task_runs
WHERE runner_id NOT IN (SELECT id FROM users);

ALTER TABLE task_runs
    ADD CONSTRAINT task_runs_ibfk_2
    FOREIGN KEY (runner_id) REFERENCES users(id) ON DELETE SET NULL;
