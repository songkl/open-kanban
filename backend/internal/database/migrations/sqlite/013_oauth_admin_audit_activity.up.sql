-- Extend the activities.action CHECK constraint with the OAuth
-- admin operations emitted by the CRUD handlers under
-- backend/internal/oauth/, and widen activities.target_type to
-- include OAUTH so the audit row identifies the surface area in
-- the activity-log view filter.
--
-- The OAuth admin audit log (s-1147, plan §6.4) wants the
-- following writes to land in the activities table rather than
-- in a bespoke admin_audit_log table:
--
--   * OAUTH_PROVIDER_CREATE   POST   /api/v1/oauth/providers
--   * OAUTH_PROVIDER_UPDATE   PUT    /api/v1/oauth/providers/:id
--   * OAUTH_PROVIDER_DELETE   DELETE /api/v1/oauth/providers/:id
--   * OAUTH_PROVIDER_ENABLE   PUT    /api/v1/oauth/providers/:id  (enabled: true)
--   * OAUTH_PROVIDER_DISABLE  PUT    /api/v1/oauth/providers/:id  (enabled: false)
--   * OAUTH_CLIENT_DELETE     DELETE /api/v1/auth/oauth/clients
--   * OAUTH_CONFIG_UPDATE     PUT    /api/v1/auth/oauth/config
--   * OAUTH_CONSENT_REVOKE    DELETE /api/v1/auth/oauth/consents
--
-- Each row records actor=user_id (the admin), target_id=the
-- resource affected, target_type='OAUTH', details=changed fields
-- (secrets are never written — only their presence flag) and the
-- client IP. The schema (columns, types, defaults, FK) is
-- intentionally identical to 002 / 007 — only the action CHECK
-- list and the target_type CHECK list grow.
--
-- This migration follows the same rebuild-the-table pattern as
-- 002 / 007: SQLite can't DROP CONSTRAINT, so we re-create the
-- table with the extended CHECK list and copy rows across. The
-- companion .down.sql rebuilds the table back to the previous
-- CHECK list, dropping any rows whose action/target_type was
-- newly permitted (the OAUTH_* actions and the OAUTH target_type).

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
        'OAUTH_CONSENT_REVOKE'
    )),
    target_type TEXT NOT NULL CHECK(target_type IN (
        'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE', 'OAUTH'
    )),
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
