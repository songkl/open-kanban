-- Reverse of 002_extend_activity_actions.up.sql: rebuild the
-- activities table with the original CHECK list (the one baked
-- into 001_initial_schema.up.sql).
--
-- Because the up migration widened the constraint, the down
-- migration has to drop any rows whose action is no longer
-- permitted (PERMISSION_GRANT, PERMISSION_REVOKE) — otherwise the
-- INSERT INTO activities_old … SELECT would violate the strict
-- CHECK. This is intentional: rolling back a schema change is
-- allowed to be lossy.

PRAGMA foreign_keys = OFF;

CREATE TABLE activities_old (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK',
        'ADD_COMMENT', 'LOGIN', 'LOGOUT',
        'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE',
        'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE',
        'USER_CREATE', 'USER_UPDATE',
        'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT',
        'APP_CONFIG_UPDATE'
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

INSERT INTO activities_old
    SELECT * FROM activities
    WHERE action NOT IN ('PERMISSION_GRANT', 'PERMISSION_REVOKE');

DROP TABLE activities;

ALTER TABLE activities_old RENAME TO activities;

CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_action_target ON activities(action, target_type);

PRAGMA foreign_keys = ON;
