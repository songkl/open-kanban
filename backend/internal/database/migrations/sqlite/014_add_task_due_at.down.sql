-- Reverse of 014_add_task_due_at.up.sql. Drops the index first so
-- the down migration stays symmetric with the up migration (matches
-- the SQLite / MySQL pair used by migrations 008 and 013).

DROP INDEX IF EXISTS idx_tasks_due_at;

-- SQLite (>= 3.35.0) supports ALTER TABLE DROP COLUMN. The shipped
-- binary is newer than that, so the DROP is safe. There is no
-- IF EXISTS clause for ALTER TABLE DROP COLUMN in SQLite, so the
-- statement will fail when the column was already removed by hand
-- — operators in that situation can run `migrate up` instead of
-- `migrate down`.
ALTER TABLE tasks DROP COLUMN due_at;