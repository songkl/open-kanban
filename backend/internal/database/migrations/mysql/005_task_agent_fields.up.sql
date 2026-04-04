-- Add agent_id and agent_prompt columns to tasks table
ALTER TABLE tasks ADD COLUMN agent_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN agent_prompt TEXT;
