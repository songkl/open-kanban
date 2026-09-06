-- Reverse of 007_add_permission_audit_fields.up.sql: drop the audit
-- columns and their indexes. MySQL has no DROP CONSTRAINT IF EXISTS
-- for foreign keys, but it tolerates a DROP on a missing constraint
-- after IF EXISTS, so we guard each DROP with a generated EXISTS
-- lookup against information_schema. The columns are dropped in
-- order so each FK is removed before its target column disappears.
--
-- The audit data (granted_by / expires_at / revoked_at / revoked_by
-- / notes) is lost on rollback — this is intentional and matches
-- the project's migration policy (rolling back a schema change is
-- allowed to be lossy).

SET @drop_revoked_bp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND index_name = 'idx_board_permissions_revoked'
        ),
        'DROP INDEX idx_board_permissions_revoked ON board_permissions',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_bp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_revoked_cp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'column_permissions'
              AND index_name = 'idx_column_permissions_revoked'
        ),
        'DROP INDEX idx_column_permissions_revoked ON column_permissions',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_cp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_notes := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND column_name = 'notes'
        ),
        'ALTER TABLE board_permissions DROP COLUMN notes',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_notes; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_revoked_by_bp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND column_name = 'revoked_by_user_id'
        ),
        'ALTER TABLE board_permissions DROP COLUMN revoked_by_user_id',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_by_bp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_revoked_at_bp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND column_name = 'revoked_at'
        ),
        'ALTER TABLE board_permissions DROP COLUMN revoked_at',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_at_bp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_expires_bp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND column_name = 'expires_at'
        ),
        'ALTER TABLE board_permissions DROP COLUMN expires_at',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_expires_bp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_granted_bp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'board_permissions'
              AND column_name = 'granted_by_user_id'
        ),
        'ALTER TABLE board_permissions DROP COLUMN granted_by_user_id',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_granted_bp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_revoked_by_cp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'column_permissions'
              AND column_name = 'revoked_by_user_id'
        ),
        'ALTER TABLE column_permissions DROP COLUMN revoked_by_user_id',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_by_cp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_revoked_at_cp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'column_permissions'
              AND column_name = 'revoked_at'
        ),
        'ALTER TABLE column_permissions DROP COLUMN revoked_at',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_revoked_at_cp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_expires_cp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'column_permissions'
              AND column_name = 'expires_at'
        ),
        'ALTER TABLE column_permissions DROP COLUMN expires_at',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_expires_cp; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @drop_granted_cp := (
    SELECT IF(
        EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'column_permissions'
              AND column_name = 'granted_by_user_id'
        ),
        'ALTER TABLE column_permissions DROP COLUMN granted_by_user_id',
        'SELECT 1'
    )
);
PREPARE stmt FROM @drop_granted_cp; EXECUTE stmt; DEALLOCATE PREPARE stmt;
