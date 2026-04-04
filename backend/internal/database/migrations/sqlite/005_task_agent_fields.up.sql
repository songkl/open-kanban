-- Add agent_id and agent_prompt columns to tasks table
ALTER TABLE tasks ADD COLUMN agent_id TEXT;
ALTER TABLE tasks ADD COLUMN agent_prompt TEXT;
