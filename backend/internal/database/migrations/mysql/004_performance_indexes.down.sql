-- Rollback performance indexes
DROP INDEX idx_tasks_column_archived ON tasks;
DROP INDEX idx_tasks_column_position ON tasks;
DROP INDEX idx_tokens_expires_at ON tokens;
DROP INDEX idx_activities_action_target ON activities;