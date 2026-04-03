-- Performance indexes for query optimization
-- Indexes for tasks table
CREATE INDEX IF NOT EXISTS idx_tasks_column_archived ON tasks(column_id, archived);
CREATE INDEX IF NOT EXISTS idx_tasks_column_position ON tasks(column_id, position);

-- Index for token expiration queries
CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON tokens(expires_at);

-- Composite index for activity queries
CREATE INDEX IF NOT EXISTS idx_activities_action_target ON activities(action, target_type);