-- Reverse of 007_device_approve_activity.up.sql: drop the widened
-- action CHECK constraint and the new target_type CHECK constraint,
-- then re-add the action CHECK to the list baked into
-- 002_extend_activity_actions.up.sql. The previous version of this
-- schema had no explicit CHECK on target_type, so the down migration
-- drops the constraint added by the up migration only.
--
-- Rows whose action was DEVICE_APPROVE or whose target_type was
-- DEVICE must be deleted by the operator (or via the SQLite companion
-- .down.sql which rebuilds the table) — this MySQL rollback leaves
-- them in place so the schema change can be reviewed before
-- destructive cleanup.

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
        'PERMISSION_GRANT', 'PERMISSION_REVOKE'
    ));

ALTER TABLE activities DROP CONSTRAINT activities_target_type_check;
