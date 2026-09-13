-- Reverse of 013_oauth_admin_audit_activity.up.sql: drop the
-- new CHECK constraints and re-add the previous lists. The
-- 007-era constraints are intentionally identical to the ones
-- baked into 007_device_approve_activity.up.sql.

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
        'DEVICE_APPROVE'
    ));

ALTER TABLE activities DROP CONSTRAINT activities_target_type_check;

ALTER TABLE activities
    ADD CONSTRAINT activities_target_type_check CHECK(target_type IN (
        'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE'
    ));
