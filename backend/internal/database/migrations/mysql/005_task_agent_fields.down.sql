-- Remove agent_id and agent_prompt columns from tasks table
ALTER TABLE tasks DROP COLUMN agent_id;
ALTER TABLE tasks DROP COLUMN agent_prompt;
