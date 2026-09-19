-- Reverse of 011_add_column_agent_transition_trigger.up.sql.
--
-- Drops the trigger-aware lookup index first so the column drop has
-- no index referencing it.

DROP INDEX idx_column_agents_transition_trigger ON column_agents;

ALTER TABLE column_agents DROP COLUMN transition_trigger;
