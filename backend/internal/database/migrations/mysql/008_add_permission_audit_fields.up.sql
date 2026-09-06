-- Add audit / lifecycle columns to board_permissions and
-- column_permissions. MySQL supports ALTER TABLE … ADD COLUMN with
-- FK references inline, so the upgrade is a straightforward DDL
-- extension — no table rebuild needed. New columns are NULLABLE
-- (or carry a DEFAULT for `notes`) so every existing row is
-- automatically backfilled with NULL / '' by the engine; no data
-- is lost.
--
-- Columns added (board_permissions):
--   granted_by_user_id  FK users.id NULLABLE — actor who issued the grant
--   expires_at          DATETIME NULLABLE  — optional access expiry
--   revoked_at          DATETIME NULLABLE  — soft-delete tombstone
--   revoked_by_user_id  FK users.id NULLABLE — actor who revoked it
--   notes               TEXT DEFAULT ''    — operator annotations
--
-- Columns added (column_permissions):
--   granted_by_user_id  FK users.id NULLABLE
--   expires_at          DATETIME NULLABLE
--   revoked_at          DATETIME NULLABLE
--   revoked_by_user_id  FK users.id NULLABLE

ALTER TABLE board_permissions
    ADD COLUMN granted_by_user_id VARCHAR(255) NULL,
    ADD COLUMN expires_at DATETIME NULL,
    ADD COLUMN revoked_at DATETIME NULL,
    ADD COLUMN revoked_by_user_id VARCHAR(255) NULL,
    ADD COLUMN notes TEXT DEFAULT '';

ALTER TABLE board_permissions
    ADD CONSTRAINT fk_board_permissions_granted_by
        FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_board_permissions_revoked_by
        FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE column_permissions
    ADD COLUMN granted_by_user_id VARCHAR(255) NULL,
    ADD COLUMN expires_at DATETIME NULL,
    ADD COLUMN revoked_at DATETIME NULL,
    ADD COLUMN revoked_by_user_id VARCHAR(255) NULL;

ALTER TABLE column_permissions
    ADD CONSTRAINT fk_column_permissions_granted_by
        FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_column_permissions_revoked_by
        FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_board_permissions_revoked ON board_permissions(revoked_at);
CREATE INDEX idx_column_permissions_revoked ON column_permissions(revoked_at);
