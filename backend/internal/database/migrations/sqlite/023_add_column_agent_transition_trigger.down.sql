-- Reverse of 011_add_column_agent_transition_trigger.up.sql:
-- rebuild column_agents back to the pre-s-1214 shape (the one baked
-- into 001_initial_schema.up.sql). The transition_trigger column is
-- dropped, so any non-default values are lost — this matches the
-- project's migration policy that a schema-rollback is allowed to be
-- lossy.

PRAGMA foreign_keys = OFF;

CREATE TABLE column_agents_old (
    id TEXT PRIMARY KEY,
    column_id TEXT UNIQUE NOT NULL,
    agent_types TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
);

INSERT INTO column_agents_old (id, column_id, agent_types, created_at, updated_at)
SELECT id, column_id, agent_types, created_at, updated_at FROM column_agents;

DROP TABLE column_agents;

ALTER TABLE column_agents_old RENAME TO column_agents;

DROP INDEX IF EXISTS idx_column_agents_transition_trigger;

PRAGMA foreign_keys = ON;
