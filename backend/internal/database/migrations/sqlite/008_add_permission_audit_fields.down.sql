-- Reverse of 007_add_permission_audit_fields.up.sql: rebuild
-- board_permissions and column_permissions back to the prior
-- schema (the one baked into 001_initial_schema.up.sql). The new
-- audit columns are dropped, so any data they held is lost — this
-- is intentional and matches the rest of the project's migration
-- policy (rolling back a schema change is allowed to be lossy).
--
-- Same PRAGMA-rebuild pattern as the up migration; without it
-- SQLite would refuse to drop the FK references that point at the
-- new columns.

PRAGMA foreign_keys = OFF;

CREATE TABLE board_permissions_old (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    owner_agent_id TEXT,
    access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
    UNIQUE(user_id, board_id)
);

INSERT INTO board_permissions_old (
    id, user_id, board_id, owner_agent_id, access, created_at, updated_at
)
SELECT
    id, user_id, board_id, owner_agent_id, access, created_at, updated_at
FROM board_permissions;

DROP TABLE board_permissions;

ALTER TABLE board_permissions_old RENAME TO board_permissions;

CREATE TABLE column_permissions_old (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE,
    UNIQUE(user_id, column_id)
);

INSERT INTO column_permissions_old (
    id, user_id, column_id, access, created_at, updated_at
)
SELECT
    id, user_id, column_id, access, created_at, updated_at
FROM column_permissions;

DROP TABLE column_permissions;

ALTER TABLE column_permissions_old RENAME TO column_permissions;

CREATE INDEX IF NOT EXISTS idx_column_permissions_user ON column_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_column_permissions_column ON column_permissions(column_id);

PRAGMA foreign_keys = ON;
