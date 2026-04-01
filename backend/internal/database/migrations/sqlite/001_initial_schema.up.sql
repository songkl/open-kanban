-- Consolidated initial schema migration v1.0.0
-- This replaces migrations 001-009

-- Users table
CREATE TABLE IF NOT EXISTS users (
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

-- Tokens table
CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    expires_at DATETIME,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Boards table
CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_alias TEXT UNIQUE,
    task_counter INTEGER DEFAULT 1000,
    deleted BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT DEFAULT ''
);

-- Board permissions table
CREATE TABLE IF NOT EXISTS board_permissions (
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

-- Columns table
CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT,
    position INTEGER DEFAULT 0,
    color TEXT DEFAULT '#6b7280',
    description TEXT DEFAULT '',
    board_id TEXT NOT NULL,
    owner_agent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);

-- Column agents table
CREATE TABLE IF NOT EXISTS column_agents (
    id TEXT PRIMARY KEY,
    column_id TEXT UNIQUE NOT NULL,
    agent_types TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    assignee TEXT,
    meta TEXT,
    column_id TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    published BOOLEAN DEFAULT 0,
    archived BOOLEAN DEFAULT 0,
    archived_at DATETIME,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    author TEXT DEFAULT 'Anonymous',
    task_id TEXT NOT NULL,
    user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Subtasks table
CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed BOOLEAN DEFAULT 0,
    task_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    storage_type TEXT DEFAULT 'local',
    mime_type TEXT,
    size INTEGER,
    uploader_id TEXT,
    task_id TEXT,
    comment_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Activities table
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT')),
    target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
    target_id TEXT,
    target_title TEXT,
    details TEXT,
    ip_address TEXT,
    source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Templates table
CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    board_id TEXT,
    columns_config TEXT NOT NULL,
    include_tasks BOOLEAN DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
);

-- App config table
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
);

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

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
