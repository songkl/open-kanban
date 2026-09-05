-- Consolidated MySQL schema for open-kanban.
--
-- This file is the single source of truth for the MySQL schema. Every
-- CREATE TABLE / ALTER TABLE / CREATE INDEX that the application needs
-- is here. There is no in-place upgrade path; the server expects to
-- bring an empty database up to this shape in one shot. Operators who
-- need a destructive reset can `migrate down` (drops everything) and
-- then `migrate up` again.

-- =====================================================================
-- Core tables
-- =====================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    nickname VARCHAR(255) NOT NULL,
    avatar TEXT,
    password VARCHAR(255),
    type VARCHAR(20) DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
    role VARCHAR(20) DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
    enabled TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tokens table
CREATE TABLE IF NOT EXISTS tokens (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    `key` VARCHAR(255) UNIQUE NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NULL,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Boards table
CREATE TABLE IF NOT EXISTS boards (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    short_alias VARCHAR(20) UNIQUE,
    task_counter INT DEFAULT 1000,
    deleted TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Board permissions table
CREATE TABLE IF NOT EXISTS board_permissions (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    board_id VARCHAR(255) NOT NULL,
    owner_agent_id VARCHAR(255),
    access VARCHAR(20) DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_board (user_id, board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columns table
CREATE TABLE IF NOT EXISTS `columns` (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50),
    position INT DEFAULT 0,
    color VARCHAR(20) DEFAULT '#6b7280',
    description TEXT,
    board_id VARCHAR(255) NOT NULL,
    owner_agent_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Column agents table
CREATE TABLE IF NOT EXISTS column_agents (
    id VARCHAR(255) PRIMARY KEY,
    column_id VARCHAR(255) UNIQUE NOT NULL,
    agent_types TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES `columns`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    priority VARCHAR(20) DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    assignee VARCHAR(255),
    agent_id VARCHAR(255),
    agent_prompt TEXT,
    meta JSON,
    column_id VARCHAR(255) NOT NULL,
    position INT DEFAULT 0,
    published TINYINT(1) DEFAULT 0,
    archived TINYINT(1) DEFAULT 0,
    archived_at TIMESTAMP NULL,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (column_id) REFERENCES `columns`(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id VARCHAR(255) PRIMARY KEY,
    content TEXT NOT NULL,
    author VARCHAR(255) DEFAULT 'Anonymous',
    task_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subtasks table
CREATE TABLE IF NOT EXISTS subtasks (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    completed TINYINT(1) DEFAULT 0,
    task_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
    id VARCHAR(255) PRIMARY KEY,
    filename VARCHAR(500) NOT NULL,
    storage_path VARCHAR(1000) NOT NULL,
    storage_type VARCHAR(20) DEFAULT 'local',
    mime_type VARCHAR(100),
    size BIGINT,
    uploader_id VARCHAR(255),
    task_id VARCHAR(255),
    comment_id VARCHAR(255),
    access_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activities table
CREATE TABLE IF NOT EXISTS activities (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    action VARCHAR(50) NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id VARCHAR(255),
    target_title VARCHAR(500),
    details TEXT,
    ip_address VARCHAR(45),
    source VARCHAR(20) DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Templates table
CREATE TABLE IF NOT EXISTS templates (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    board_id VARCHAR(255),
    columns_config TEXT NOT NULL,
    include_tasks TINYINT(1) DEFAULT 0,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- App config table
CREATE TABLE IF NOT EXISTS app_config (
    `key` VARCHAR(255) PRIMARY KEY,
    value TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-column permission overrides. When a board grants a user a base
-- access level via board_permissions, column_permissions can raise or
-- lower the access for a specific column. (E.g. board = READ, this
-- row = WRITE to allow editing one specific column.) The UNIQUE
-- (user_id, column_id) constraint is the target of the SetColumnPermission
-- handler's upsert.
CREATE TABLE IF NOT EXISTS column_permissions (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    column_id VARCHAR(255) NOT NULL,
    access VARCHAR(20) NOT NULL DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (column_id) REFERENCES `columns`(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_column_permissions (user_id, column_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
-- OAuth 2.1 tables (RFC 7591 dynamic client registration, device flow,
-- refresh tokens, per-user consents). All explicitly pin the same
-- CHARSET/COLLATE as the core tables so that FOREIGN KEY columns
-- match users.id exactly — MySQL 8.0+ would otherwise assign
-- utf8mb4_0900_ai_ci (the server default) and fail with Error 3780
-- at CREATE TABLE time.
-- =====================================================================

CREATE TABLE IF NOT EXISTS oauth_clients (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(255) UNIQUE NOT NULL,
    client_secret_hash TEXT,
    name VARCHAR(255) NOT NULL,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    token_endpoint_auth_method VARCHAR(64) NOT NULL DEFAULT 'none',
    scopes TEXT NOT NULL,
    is_first_party TINYINT(1) DEFAULT 0,
    created_by_user_id VARCHAR(64),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_clients_client_id ON oauth_clients(client_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code VARCHAR(255) PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method VARCHAR(16),
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_authcodes_client ON oauth_authorization_codes(client_id);
CREATE INDEX idx_oauth_authcodes_user ON oauth_authorization_codes(user_id);
CREATE INDEX idx_oauth_authcodes_expires ON oauth_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_device_codes (
    id VARCHAR(64) PRIMARY KEY,
    device_code_hash VARCHAR(128) UNIQUE NOT NULL,
    user_code_hash VARCHAR(128) UNIQUE NOT NULL,
    user_code_display VARCHAR(32) NOT NULL,
    client_id VARCHAR(255) NOT NULL,
    scope TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    interval_seconds INT DEFAULT 5,
    last_poll_at DATETIME,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    user_id VARCHAR(64),
    verification_uri TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_device_client ON oauth_device_codes(client_id);
CREATE INDEX idx_oauth_device_status ON oauth_device_codes(status);
CREATE INDEX idx_oauth_device_expires ON oauth_device_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id VARCHAR(64) PRIMARY KEY,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    client_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    scope TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    replaced_by_id VARCHAR(64),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);
CREATE INDEX idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);
CREATE INDEX idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS oauth_consents (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    client_id VARCHAR(255) NOT NULL,
    scope TEXT NOT NULL,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_oauth_consents (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_oauth_consents_user ON oauth_consents(user_id);

-- =====================================================================
-- Indexes (collected at the end so the schema reads top-down: tables
-- first, then lookups).
-- =====================================================================

CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_comment ON attachments(comment_id);
CREATE INDEX idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX idx_activities_user ON activities(user_id);
CREATE INDEX idx_activities_created ON activities(created_at DESC);
CREATE INDEX idx_activities_action_target ON activities(action, target_type);
CREATE INDEX idx_users_last_active ON users(last_active_at);
CREATE INDEX idx_tasks_created_by ON tasks(created_by);
CREATE INDEX idx_tasks_column_position ON tasks(column_id, position);
CREATE INDEX idx_tasks_column_archived ON tasks(column_id, archived);
CREATE INDEX idx_tasks_archived_published ON tasks(archived, published);
CREATE INDEX idx_tokens_expires_at ON tokens(expires_at);
CREATE INDEX idx_column_permissions_user ON column_permissions(user_id);
CREATE INDEX idx_column_permissions_column ON column_permissions(column_id);
