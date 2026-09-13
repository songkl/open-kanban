-- Extend the activities.action CHECK constraint with DEVICE_APPROVE
-- and widen activities.target_type to include DEVICE.
--
-- Device-flow agent selection (s-1118, plan §4.1.1 + §4.4) wants the
-- /oauth/device/approve handler to write an audit row whenever a human
-- approver delegates a device code to an Agent identity. The audit
-- row records actor=human approver (user_id) and target=Agent
-- (target_id, target_type='DEVICE'). The existing CHECK constraint on
-- activities.action would reject the new value, and an explicit CHECK
-- on activities.target_type does not exist on MySQL today — so this
-- migration widens the action CHECK and adds a fresh target_type
-- CHECK in lock-step with the SQLite companion file.
--
-- The action CHECK was added in 002_extend_activity_actions.up.sql
-- with the explicit name `activities_action_check` and must be
-- dropped before re-adding it. The new target_type CHECK follows the
-- same naming convention.

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

ALTER TABLE activities
    ADD CONSTRAINT activities_target_type_check CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE', 'DEVICE'));
