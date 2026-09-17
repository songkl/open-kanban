-- Column workflow triggers (s-1214, PM_REVIEW_2026-09-17 §3.5).
--
-- `column_agents` already binds a column to one or more Agent types
-- via the JSON-encoded `agent_types` column, but it does not yet
-- decide when those Agents should be woken up. This migration adds a
-- `transition_trigger` flag so a column can opt-in to firing an Agent
-- run automatically when a task crosses the column boundary:
--
--   'none'      default — the binding is purely declarative; nothing
--               fires on transition (preserves the legacy behaviour
--               for every existing row).
--   'on_enter'  fire when a task moves INTO this column.
--   'on_exit'   fire when a task moves OUT OF this column.
--   'both'      fire on both edges.
--
-- The CHECK constraint mirrors the enum the Go handler validates
-- against (see internal/handlers/columns.go SetColumnAgentRequest).
--
-- We rebuild the table (same PRAGMA-rebuild pattern as 008) instead
-- of issuing a plain ALTER TABLE ADD COLUMN so the down migration can
-- reverse cleanly. SQLite does not support DROP COLUMN on the
-- build of go-sqlite3 we link, and a non-reversible migration would
-- break `m.Steps(-N); m.Steps(+N)` round-trips in the migrations
-- test (internal/database/migrations_007_test.go).

PRAGMA foreign_keys = OFF;

CREATE TABLE column_agents_new (
    id TEXT PRIMARY KEY,
    column_id TEXT UNIQUE NOT NULL,
    agent_types TEXT NOT NULL,
    transition_trigger TEXT NOT NULL DEFAULT 'none',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
);

INSERT INTO column_agents_new (id, column_id, agent_types, created_at, updated_at)
SELECT id, column_id, agent_types, created_at, updated_at FROM column_agents;

DROP TABLE column_agents;

ALTER TABLE column_agents_new RENAME TO column_agents;

CREATE INDEX IF NOT EXISTS idx_column_agents_transition_trigger
    ON column_agents(transition_trigger);

PRAGMA foreign_keys = ON;
