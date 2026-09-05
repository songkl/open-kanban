-- Extend the activities.action CHECK constraint to permit the new
-- PERMISSION_GRANT / PERMISSION_REVOKE action types emitted by the
-- SetPermission / SetColumnPermission / DeletePermission /
-- DeleteColumnPermission handlers.
--
-- SQLite does not support ALTER TABLE … DROP CONSTRAINT, so the
-- standard "edit history in place" pattern of a CREATE TABLE …
-- CHECK … no longer matches the production table. The portable
-- workaround is to rebuild the table in a transaction:
--
--   1. PRAGMA foreign_keys = OFF  (so the rebuild doesn't trip on
--      self-referential / cross-referential FK enforcement)
--   2. CREATE TABLE activities_new with the extended CHECK list
--   3. INSERT … SELECT from the old table to copy every row
--   4. DROP TABLE activities
--   5. ALTER TABLE activities_new RENAME TO activities
--   6. Recreate the indexes that lived on the old table
--   7. PRAGMA foreign_keys = ON
--
-- The schema (columns, types, defaults, FK target_type list) is
-- intentionally identical to 001_initial_schema.up.sql — only the
-- action CHECK list grows. The companion .down.sql rebuilds the
-- table back to the original CHECK list, dropping any rows whose
-- action was newly permitted (PERMISSION_GRANT, PERMISSION_REVOKE).

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
        'PERMISSION_GRANT', 'PERMISSION_REVOKE'
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
