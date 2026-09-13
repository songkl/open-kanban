-- Extend the activities.action CHECK constraint with the OAuth
-- admin operations emitted by the CRUD handlers under
-- backend/internal/oauth/, and widen activities.target_type to
-- include OAUTH so the audit row identifies the surface area in
-- the activity-log view filter.
--
-- See the SQLite companion file for the rationale; the action
-- list and target_type list are kept identical across the two
-- engines so a future operator can swap engines without
-- auditing the audit table. The action CHECK was added in 002 /
-- 007 with the explicit name `activities_action_check` and must
-- be dropped before re-adding it. The target_type CHECK follows
-- the same naming convention.

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
        'OAUTH_CONSENT_REVOKE'
    ));

ALTER TABLE activities DROP CONSTRAINT activities_target_type_check;

ALTER TABLE activities
    ADD CONSTRAINT activities_target_type_check CHECK(target_type IN (
        'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE', 'OAUTH'
    ));
