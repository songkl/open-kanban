-- Extend the activities.action CHECK constraint to permit the new
-- PERMISSION_BULK_GRANT action type emitted by the BulkSetPermissions
-- handler when a board owner grants the same access level to many
-- users in a single request.
--
-- Mirrors the table-rebuild approach used by
-- 002_extend_activity_actions.up.sql and
-- 005_extend_activity_actions_transfer.up.sql: SQLite cannot ALTER
-- a CHECK constraint in place, so we rebuild the activities table
-- with the extended list while keeping every existing row and index
-- intact. The schema (columns, types, defaults, FK target_type list)
-- is intentionally identical to the prior migration — only the
-- action CHECK list grows by one entry.

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
        'PERMISSION_TRANSFER',
        'PERMISSION_BULK_GRANT'
    )),
    target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
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
