-- Extend the activities.action CHECK constraint with DEVICE_APPROVE
-- and widen activities.target_type to include DEVICE.
--
-- Device-flow agent selection (s-1118, plan §4.1.1 + §4.4) wants the
-- /oauth/device/approve handler to write an audit row whenever a human
-- approver delegates a device code to an Agent identity. The audit
-- row records actor=human approver (user_id) and target=Agent
-- (target_id, target_type='DEVICE'). The existing CHECK constraints on
-- both columns would reject the new values, so this migration widens
-- them.
--
-- This migration follows the same rebuild-the-table pattern as
-- 002_extend_activity_actions.up.sql: SQLite can't DROP CONSTRAINT, so
-- we re-create the table with the extended CHECK list and copy rows
-- across. The schema (columns, types, defaults, FK target_type list)
-- is intentionally identical to 002 — only the action and target_type
-- CHECK lists grow.
--
-- The companion .down.sql rebuilds the table back to the previous
-- CHECK list, dropping any rows whose action/target_type was newly
-- permitted (DEVICE_APPROVE / DEVICE).

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
        'DEVICE_APPROVE'
    )),
    target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE')),
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
