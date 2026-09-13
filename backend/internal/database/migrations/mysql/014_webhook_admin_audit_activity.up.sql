-- Extend the activities.action CHECK constraint with the webhook
-- admin operations emitted by the Webhook config service under
-- backend/internal/services/webhook_config_service.go (s-1140,
-- plan §6.2 in docs/EVENT_CENTER_PLAN_s-1138.md). See the SQLite
-- companion file for the rationale; the action list and
-- target_type list are kept identical across the two engines so
-- a future operator can swap engines without auditing the audit
-- table. The action CHECK and target_type CHECK were added in
-- 002 / 007 / 013 with the explicit names
-- `activities_action_check` / `activities_target_type_check` and
-- must be dropped before re-adding them.

ALTER TABLE activities DROP CONSTRAINT activities_action_check;

ALTER TABLE activities
    ADD CONSTRAINT activities_action_check CHECK(action IN (
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
    ));

ALTER TABLE activities DROP CONSTRAINT activities_target_type_check;

ALTER TABLE activities
    ADD CONSTRAINT activities_target_type_check CHECK(target_type IN (
        'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE',
        'DEVICE', 'OAUTH', 'WEBHOOK'
    ));
