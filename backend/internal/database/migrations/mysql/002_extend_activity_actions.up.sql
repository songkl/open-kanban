-- Extend the activities.action CHECK constraint to permit the new
-- PERMISSION_GRANT / PERMISSION_REVOKE action types emitted by the
-- SetPermission / SetColumnPermission / DeletePermission /
-- DeleteColumnPermission handlers.
--
-- 001_initial_schema.up.sql deliberately omitted any CHECK on the
-- action column (matches MySQL 8.0's pre-8.0.16 behaviour where
-- CHECK clauses were parsed but not enforced, and keeps the column
-- forward-compatible with new action strings added by later code).
-- This migration adds the constraint now that the Set*/Delete*
-- permission handlers exist, so the activity type-space stays
-- validated at the database layer instead of only at the handler
-- layer.
--
-- Per the project's migration guidance, this is an additive
-- migration — a future operator can roll back with the companion
-- .down.sql without losing data, since the new action types are
-- only ever written by code that is part of this release.

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
