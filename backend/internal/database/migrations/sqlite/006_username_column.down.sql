-- Remove username column (SQLite version)
CREATE TABLE users_old (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    avatar TEXT,
    password TEXT,
    type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
    role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
    enabled BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME
);

INSERT INTO users_old (id, nickname, avatar, password, type, role, enabled, created_at, updated_at, last_active_at)
SELECT id, nickname, avatar, password, type, role, enabled, created_at, updated_at, last_active_at FROM users;

DROP TABLE users;
ALTER TABLE users_old RENAME TO users;