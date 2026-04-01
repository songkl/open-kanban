-- Column permissions table for fine-grained access control
CREATE TABLE IF NOT EXISTS column_permissions (
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

CREATE INDEX IF NOT EXISTS idx_column_permissions_user ON column_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_column_permissions_column ON column_permissions(column_id);