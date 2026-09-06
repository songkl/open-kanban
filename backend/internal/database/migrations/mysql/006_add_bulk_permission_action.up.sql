-- Extend the activities.action CHECK constraint to permit the new
-- PERMISSION_BULK_GRANT action type emitted by the BulkSetPermissions
-- handler when a board owner grants the same access level to many
-- users in a single request.
--
-- MySQL 8.0+ supports adding a CHECK to an existing column via
-- ALTER TABLE … ADD CONSTRAINT … CHECK (…). The new clause is
-- additive: every previously-permitted action still satisfies the
-- broader IN (…) list, so the change is safe to apply online
-- without rewriting the table.
--
-- Note: MySQL only enforces CHECK constraints since 8.0.16, and the
-- alter is a metadata-only change, so applying this on an 8.0.16+
-- server is fast and non-blocking. On older servers the constraint
-- is parsed but ignored, which is harmless — the activity row would
-- still be inserted by the BulkSetPermissions handler.
--
-- Per the project's migration guidance, this is an additive
-- migration — a future operator can roll back with the companion
-- .down.sql without losing data, since the new action type is only
-- ever written by code that is part of this release.

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
        'PERMISSION_TRANSFER',
        'PERMISSION_BULK_GRANT'
    ));
