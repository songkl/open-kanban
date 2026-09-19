-- Reverse of 014_add_task_due_at.up.sql. MySQL needs the index
-- dropped first because the column drop fails if an index still
-- references the column, then the column itself.

DROP INDEX idx_tasks_due_at ON tasks;

ALTER TABLE tasks DROP COLUMN due_at;