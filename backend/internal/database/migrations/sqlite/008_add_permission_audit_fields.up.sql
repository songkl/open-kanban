-- Add audit / lifecycle columns to board_permissions and
-- column_permissions so the permission management surface can record
-- who granted / revoked a row, when the grant expires, when it was
-- revoked, and who did the revoking. board_permissions also gets a
-- free-form notes column for operator annotations.
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
-- (no owner concept → no owner stamp; no notes column either since
-- column-level grants are short-lived operational overrides.)
--
-- SQLite cannot ALTER TABLE ADD COLUMN with a foreign-key reference,
-- so we rebuild both tables the same way 002/005/006 rebuild the
-- activities table: create _new, copy every existing row with the
-- new columns defaulted (NULL / ''), drop the old, rename, then
-- recreate the indexes. Existing rows are preserved verbatim apart
-- from the backfilled defaults, so a SELECT COUNT(*) before and
-- after the migration returns the same number.

PRAGMA foreign_keys = OFF;

CREATE TABLE board_permissions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    owner_agent_id TEXT,
    access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    granted_by_user_id TEXT,
    expires_at DATETIME,
    revoked_at DATETIME,
    revoked_by_user_id TEXT,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(user_id, board_id)
);

INSERT INTO board_permissions_new (
    id, user_id, board_id, owner_agent_id, access,
    granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes,
    created_at, updated_at
)
SELECT
    id, user_id, board_id, owner_agent_id, access,
    NULL, NULL, NULL, NULL, '',
    created_at, updated_at
FROM board_permissions;

DROP TABLE board_permissions;

ALTER TABLE board_permissions_new RENAME TO board_permissions;

CREATE TABLE column_permissions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    granted_by_user_id TEXT,
    expires_at DATETIME,
    revoked_at DATETIME,
    revoked_by_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(user_id, column_id)
);

INSERT INTO column_permissions_new (
    id, user_id, column_id, access,
    granted_by_user_id, expires_at, revoked_at, revoked_by_user_id,
    created_at, updated_at
)
SELECT
    id, user_id, column_id, access,
    NULL, NULL, NULL, NULL,
    created_at, updated_at
FROM column_permissions;

DROP TABLE column_permissions;

ALTER TABLE column_permissions_new RENAME TO column_permissions;

CREATE INDEX IF NOT EXISTS idx_column_permissions_user ON column_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_column_permissions_column ON column_permissions(column_id);

-- Match the MySQL migration: the (board_permissions, revoked_at) and
-- (column_permissions, revoked_at) indexes let the loadBoardAccess /
-- loadColumnAccess `revoked_at IS NULL` filter scan a small index
-- instead of doing a full table scan once the soft-delete tombstone
-- becomes the dominant shape (i.e. most historical grants revoked
-- after a permission-cleanup pass).
CREATE INDEX IF NOT EXISTS idx_board_permissions_revoked ON board_permissions(revoked_at);
CREATE INDEX IF NOT EXISTS idx_column_permissions_revoked ON column_permissions(revoked_at);

PRAGMA foreign_keys = ON;
