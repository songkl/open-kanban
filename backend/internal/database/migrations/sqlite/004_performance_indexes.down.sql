-- Rollback performance indexes
DROP INDEX IF EXISTS idx_tasks_column_archived ON tasks;
DROP INDEX IF EXISTS idx_tasks_column_position ON tasks;
DROP INDEX IF EXISTS idx_tokens_expires_at ON tokens;
DROP INDEX IF EXISTS idx_activities_action_target ON activities;