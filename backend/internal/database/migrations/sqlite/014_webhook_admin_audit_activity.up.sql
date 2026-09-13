-- Extend the activities.action CHECK constraint with the webhook
-- admin operations emitted by the Webhook config service under
-- backend/internal/services/webhook_config_service.go (s-1140,
-- plan §6.2 in docs/EVENT_CENTER_PLAN_s-1138.md).
--
-- The webhook centre ships its actions in the
-- "<surface>.<verb>" dotted notation that the plan authors
-- already use in the plan document (e.g. webhook.created,
-- webhook.updated, webhook.deleted, webhook.rotated,
-- webhook.tested) — distinct from the snake_case UPPER style
-- used by the OAuth admin audit migration 013. Keeping the
-- dotted style matches what the plan document promises and what
-- the WebhookCenter UI will filter on, so we add a fresh allow-list
-- rather than retro-fitting the OAuth ones.
--
-- target_type is widened with WEBHOOK so the activity-log feed can
-- group the webhook surface area separately from OAUTH (migration
-- 013) and DEVICE (migration 007).
--
-- This migration follows the same rebuild-the-table pattern as
-- 002 / 007 / 013: SQLite can't DROP CONSTRAINT, so we re-create
-- the table with the extended CHECK list and copy rows across.
-- Rows whose action / target_type was previously permitted are
-- preserved verbatim. The companion .down.sql rebuilds the table
-- back to the 013 CHECK list, dropping any rows whose action /
-- target_type was newly permitted (the webhook.* actions and the
-- WEBHOOK target_type).

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
        'webhook.rotated', 'webhook.tested'
    )),
    target_type TEXT NOT NULL CHECK(target_type IN (
        'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE',
        'DEVICE', 'OAUTH', 'WEBHOOK'
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
