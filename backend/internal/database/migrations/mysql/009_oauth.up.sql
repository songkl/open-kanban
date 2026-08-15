-- OAuth 2.1 tables (MySQL flavor). JSON columns use TEXT with JSON_VALID() guards.

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
);

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
);

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
);

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
);

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
);

CREATE INDEX idx_oauth_consents_user ON oauth_consents(user_id);