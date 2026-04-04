-- Add username column for separate login name (SQLite version)
-- SQLite doesn't support ALTER TABLE ADD COLUMN with UNIQUE, so we recreate the table
CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
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

INSERT INTO users_new (id, nickname, avatar, password, type, role, enabled, created_at, updated_at, last_active_at)
SELECT id, nickname, avatar, password, type, role, enabled, created_at, updated_at, last_active_at FROM users;

UPDATE users_new SET username = nickname WHERE username IS NULL;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;