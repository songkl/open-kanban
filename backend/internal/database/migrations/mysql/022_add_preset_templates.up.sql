-- MySQL sibling of the SQLite 010 migration. See
-- ../../sqlite/010_add_preset_templates.up.sql for the full design note.
--
-- MySQL-specific bits:
--   * VARCHAR sizes match the project's MySQL conventions (VARCHAR(64)
--     for ids, VARCHAR(255) for short strings, TEXT for free-form).
--   * JSON-encoded TEXT columns for columns_config / sample_tasks — the
--     Go handler decodes them with encoding/json so we don't need the
--     MySQL JSON type and can keep the schema SQLite-compatible.
--   * utf8mb4 charset so emoji-rich preset names round-trip cleanly.
--
-- The seed at the bottom mirrors the SQLite migration 1:1 (the column
-- names / types are intentionally aligned so a future PR can lift the
-- seed into a shared Go function if more presets are added). INSERT
-- IGNORE is MySQL's equivalent of SQLite's INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS preset_templates (
    id VARCHAR(64) PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(64) NOT NULL DEFAULT '',
    columns_config TEXT NOT NULL,
    sample_tasks TEXT NOT NULL,
    sample_agent TEXT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_preset_templates_position
    ON preset_templates(position);

INSERT IGNORE INTO preset_templates (id, slug, name, description, category, columns_config, sample_tasks, sample_agent, position, enabled) VALUES
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