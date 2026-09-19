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
-- Existing rows are backfilled with 'none' by the DEFAULT clause so
-- the upgrade is non-destructive.

ALTER TABLE column_agents
    ADD COLUMN transition_trigger VARCHAR(16) NOT NULL DEFAULT 'none'
    CHECK (transition_trigger IN ('none', 'on_enter', 'on_exit', 'both'));

CREATE INDEX idx_column_agents_transition_trigger
    ON column_agents(transition_trigger);
