-- Onboarding flow + template marketplace (s-1196, PM_REVIEW_2026-09-17
-- §5.4 ROI #4 / §6).
--
-- The default `templates` table holds per-board "save as template"
-- artefacts owned by a single user; that's the wrong shape for the
-- first-login wizard and the public marketplace because those rows
-- must be visible to every account (even ones with no boards yet) and
-- must ship with a curated set of seeded entries. A separate
-- `preset_templates` table makes the new surface area independent of
-- the existing user-template flow — existing user-saved templates are
-- untouched, and presets can be disabled wholesale by an admin via the
-- `marketplaceEnabled` app_config key (the Go handler reads it, not the
-- schema).
--
-- Schema shape:
--   id              — stable slug-like identifier (e.g. "product-iteration").
--                     We don't expose the row's internal id outside the
--                     server, so a readable primary key is fine and makes
--                     the GET endpoint self-describing.
--   slug            — same as id, kept redundant for forward-compat
--                     with marketplace UI that wants to filter / route by
--                     slug without parsing the id column.
--   name            — display name (e.g. "Product iteration").
--   description     — short pitch shown in the marketplace card.
--   category        — taxonomy label (e.g. "engineering", "support").
--   columns_config  — JSON-encoded []ColumnConfig matching the existing
--                     user-template shape, so CreateBoardFromTemplate
--                     can be reused unchanged.
--   sample_tasks    — JSON-encoded array of {title, columnIndex,
--                     description?, priority?} used by the onboarding
--                     wizard to drop a single representative card into
--                     the freshly-created board so the new user lands on
--                     a non-empty page.
--   sample_agent    — optional nickname+avatar for the sample Agent the
--                     wizard installs in step 3 of the onboarding flow.
--                     Empty string means "skip the agent install".
--   position        — explicit ordering for the marketplace (lowest first).
--   enabled         — admin can disable a single preset without deleting
--                     the row (still seeded back on a fresh DB).
--   created_at /
--   updated_at      — audit timestamps.

CREATE TABLE IF NOT EXISTS preset_templates (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    columns_config TEXT NOT NULL,
    sample_tasks TEXT NOT NULL DEFAULT '[]',
    sample_agent TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_preset_templates_position
    ON preset_templates(position);

-- =====================================================================
-- Seed data (s-1196).
--
-- Four curated presets per the PM spec §6:
--   1. Product iteration  — engineering squad cycle
--   2. Bug triage         — incoming issue queue
--   3. Content calendar   — marketing editorial pipeline
--   4. Customer support   — ticket routing
--
-- Each preset ships with a single sample task and (for most) a sample
-- Agent nickname the onboarding wizard can install in step 3. The
-- `columns_config` JSON shape matches the existing user-template
-- shape (`[{name, position, color, status}]`) so
-- `CreateBoardFromTemplate` (templates_board_create.go) can hydrate a
-- board from a preset without a parallel code path.
--
-- INSERT OR IGNORE keeps the seed idempotent if an admin re-runs the
-- migration (e.g. after a down/up cycle) and respects any manual
-- edits: rows the admin has touched keep their (id, slug) but the
-- other columns are left as-is on the INSERT OR IGNORE no-op.
-- =====================================================================

INSERT OR IGNORE INTO preset_templates (id, slug, name, description, category, columns_config, sample_tasks, sample_agent, position, enabled) VALUES
('product-iteration', 'product-iteration',
 'Product iteration',
 'Ship features in tight cycles: backlog → in progress → review → done.',
 'engineering',
 '[{"name":"Backlog","position":0,"color":"#94a3b8","status":"todo"},{"name":"In progress","position":1,"color":"#3b82f6","status":"in_progress"},{"name":"Review","position":2,"color":"#a855f7","status":"review"},{"name":"Shipped","position":3,"color":"#22c55e","status":"done"}]',
 '[{"title":"Welcome — drag this card to ship it","columnIndex":0,"description":"Try moving me between columns to see how the board reacts.","priority":"medium"}]',
 'Iteration Bot',
 0, 1),

('bug-triage', 'bug-triage',
 'Bug triage',
 'Catch incoming bugs, reproduce them, and route fixes to engineering.',
 'support',
 '[{"name":"Reported","position":0,"color":"#ef4444","status":"todo"},{"name":"Reproduced","position":1,"color":"#f59e0b","status":"in_progress"},{"name":"Fix in progress","position":2,"color":"#3b82f6","status":"in_progress"},{"name":"Verified","position":3,"color":"#22c55e","status":"done"}]',
 '[{"title":"Sample bug — login fails on Safari","columnIndex":0,"description":"Use this card to test your triage flow.","priority":"high"}]',
 'Triage Bot',
 1, 1),

('content-calendar', 'content-calendar',
 'Content calendar',
 'Plan, draft, and publish content across channels.',
 'marketing',
 '[{"name":"Ideas","position":0,"color":"#a78bfa","status":"todo"},{"name":"Drafting","position":1,"color":"#3b82f6","status":"in_progress"},{"name":"Review","position":2,"color":"#a855f7","status":"review"},{"name":"Published","position":3,"color":"#22c55e","status":"done"}]',
 '[{"title":"Welcome post — replace with your first draft","columnIndex":0,"description":"Drop a topic idea here and start drafting.","priority":"low"}]',
 'Editorial Bot',
 2, 1),

('customer-support', 'customer-support',
 'Customer support',
 'Triage customer requests from intake to resolution.',
 'support',
 '[{"name":"Inbox","position":0,"color":"#94a3b8","status":"todo"},{"name":"Waiting on customer","position":1,"color":"#f59e0b","status":"in_progress"},{"name":"In progress","position":2,"color":"#3b82f6","status":"in_progress"},{"name":"Resolved","position":3,"color":"#22c55e","status":"done"}]',
 '[{"title":"Sample ticket — onboarding question","columnIndex":0,"description":"Drag me through the support workflow to see how routing works.","priority":"medium"}]',
 'Support Bot',
 3, 1);