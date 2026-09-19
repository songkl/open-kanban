-- Task due date column (T-1207 / s-1207, PM_REVIEW_2026-09-17 §3.12).
--
-- MySQL side mirrors the SQLite side in
-- 014_add_task_due_at.up.sql. DATETIME NULL so existing rows stay
-- at NULL, no default is applied so the application layer can use
-- Go's zero-value *time.Time as "no due date". The idx_tasks_due_at
-- index is built in the same statement so the migration runner
-- rebuilds it in one transaction.
--
-- MySQL 8.0+ defaults to INSTANT DDL for ALTER TABLE ADD COLUMN,
-- so adding a nullable column without a default is a metadata-only
-- operation and finishes in milliseconds regardless of the row
-- count.

ALTER TABLE tasks ADD COLUMN due_at DATETIME NULL AFTER archived_at;

CREATE INDEX idx_tasks_due_at ON tasks(due_at);