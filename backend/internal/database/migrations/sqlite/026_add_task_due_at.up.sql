-- Task due date column (T-1207 / s-1207, PM_REVIEW_2026-09-17 §3.12).
--
-- The PM review flagged that the create-task modal is missing three
-- basic fields the rest of the product assumes exist: a due-date
-- picker, an explicit assignee picker, and an attachment upload
-- control. Of those three the due date is the only one that requires
-- a schema change — assignee is already a free-text column on the
-- tasks table, and attachments already live in their own table with
-- a nullable task_id FK. This migration adds a nullable DATETIME
-- column `due_at` to tasks so a freshly created task can carry a
-- due date straight through the modal into the storage layer
-- without needing to be edited immediately afterwards.
--
-- Columns:
--   due_at — DATETIME NULLABLE. No default; existing rows are
--            backfilled with NULL. The column is intentionally
--            nullable so tasks without a due date (the legacy
--            default) keep working and the migration is
--            non-destructive. The application layer is the source
--            of truth for "no due date" (Go zero-value *time.Time
--            round-trips as NULL).
--
-- Index:
--   idx_tasks_due_at — speeds up the upcoming "overdue" / "due in
--                      next N days" surface the PM review hinted at
--                      (PM_REVIEW §3.12 follow-on). Kept in the up
--                      migration because a one-time rebuild on a
--                      populated table is cheaper than a
--                      background-rebuild index.

ALTER TABLE tasks ADD COLUMN due_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);