-- OAuth 2.1 tables for dynamic client registration, device flow, refresh tokens, and consents.
-- See docs for grant_type support: device_code, authorization_code, refresh_token, client_credentials.

CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    client_id TEXT UNIQUE NOT NULL,
    client_secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    grant_types TEXT NOT NULL DEFAULT '[]',
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    scopes TEXT NOT NULL DEFAULT '[]',
    is_first_party BOOLEAN DEFAULT 0,
    created_by_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_authcodes_client ON oauth_authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_authcodes_user ON oauth_authorization_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_authcodes_expires ON oauth_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_device_codes (
    id TEXT PRIMARY KEY,
    device_code_hash TEXT UNIQUE NOT NULL,
    user_code_hash TEXT UNIQUE NOT NULL,
    user_code_display TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    interval_seconds INTEGER DEFAULT 5,
    last_poll_at DATETIME,
    status TEXT NOT NULL DEFAULT 'pending',
    user_id TEXT,
    verification_uri TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_device_client ON oauth_device_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_device_status ON oauth_device_codes(status);
CREATE INDEX IF NOT EXISTS idx_oauth_device_expires ON oauth_device_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    replaced_by_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS oauth_consents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_consents_user ON oauth_consents(user_id);