-- Extend the activities.action CHECK constraint to permit the new
-- BULK_ARCHIVE_COLUMN / BULK_COMPLETE_COLUMN action types emitted by
-- the BulkColumnAction handler (s-1212) when a column header
-- "Archive all" / "Mark all as completed" action archives or
-- advances every task in a column in a single request.
--
-- Mirrors the table-rebuild approach used by
-- 002_extend_activity_actions.up.sql,
-- 005_extend_activity_actions_transfer.up.sql, and
-- 006_add_bulk_permission_action.up.sql: SQLite cannot ALTER a
-- CHECK constraint in place, so we rebuild the activities table
-- with the extended list while keeping every existing row and
-- index intact. The schema (columns, types, defaults, FK target_type
-- list) is intentionally identical to the prior migration — only
-- the action CHECK list grows by two entries.
--
-- Per the project's migration guidance, this is an additive
-- migration — a future operator can roll back with the companion
-- .down.sql without losing data, since the new action types are
-- only ever written by code that is part of this release.

PRAGMA foreign_keys = OFF;

CREATE TABLE activities_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK',
        'ADD_COMMENT', 'LOGIN', 'LOGOUT',
        'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE',
        'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE',
        'USER_CREATE', 'USER_UPDATE',
        'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT',
        'APP_CONFIG_UPDATE',
        'PERMISSION_GRANT', 'PERMISSION_REVOKE',
        'DEVICE_APPROVE',
        'OAUTH_PROVIDER_CREATE', 'OAUTH_PROVIDER_UPDATE', 'OAUTH_PROVIDER_DELETE',
        'OAUTH_PROVIDER_ENABLE', 'OAUTH_PROVIDER_DISABLE',
        'OAUTH_CLIENT_DELETE',
        'OAUTH_CONFIG_UPDATE',
        'OAUTH_CONSENT_REVOKE',
        'webhook.created', 'webhook.updated', 'webhook.deleted',
        'webhook.rotated', 'webhook.tested',
        'PERMISSION_TRANSFER',
        'PERMISSION_BULK_GRANT',
        'BULK_ARCHIVE_COLUMN', 'BULK_COMPLETE_COLUMN'
    )),
    target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE', 'OAUTH', 'WEBHOOK')),
    target_id TEXT,
    target_title TEXT,
    details TEXT,
    ip_address TEXT,
    source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO activities_new
    SELECT * FROM activities;

DROP TABLE activities;

ALTER TABLE activities_new RENAME TO activities;

CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_action_target ON activities(action, target_type);

PRAGMA foreign_keys = ON;
