package oauth

import (
	"database/sql"
	"fmt"
)

// ConfigKey defines the canonical set of OAuth-related app_config keys.
type ConfigKey struct {
	Key         string
	DefaultVal  string
	Description string
}

// DefaultConfig returns the canonical OAuth config keys with defaults. The
// admin settings page surfaces these and stores overrides in app_config.
func DefaultConfig() []ConfigKey {
	return []ConfigKey{
		{
			Key:         "oauth_enabled",
			DefaultVal:  "1",
			Description: "Master switch for OAuth 2.1 endpoints. When 0 the legacy tokens table continues to work.",
		},
		{
			Key:         "oauth_allow_dynamic_client_registration",
			DefaultVal:  "1",
			Description: "Allow /oauth/register without a pre-provisioned client.",
		},
		{
			Key:         "oauth_require_pkce",
			DefaultVal:  "1",
			Description: "Require PKCE for the authorization_code grant.",
		},
		{
			Key:         "oauth_access_token_ttl_seconds",
			DefaultVal:  "3600",
			Description: "Access token lifetime in seconds (1 hour default).",
		},
		{
			Key:         "oauth_refresh_token_ttl_seconds",
			DefaultVal:  "2592000",
			Description: "Refresh token lifetime in seconds (30 days default).",
		},
		{
			Key:         "oauth_device_code_ttl_seconds",
			DefaultVal:  "600",
			Description: "Device code lifetime in seconds (10 minutes default).",
		},
		{
			Key:         "oauth_device_poll_interval_seconds",
			DefaultVal:  "5",
			Description: "Minimum interval between device code polls.",
		},
		{
			Key:         "oauth_authorization_code_ttl_seconds",
			DefaultVal:  "120",
			Description: "Authorization code lifetime in seconds (2 minutes default).",
		},
		{
			Key:         "oauth_audience",
			DefaultVal:  "kanban",
			Description: "aud claim used in issued access tokens.",
		},
		{
			Key:         "oauth_issuer_override",
			DefaultVal:  "",
			Description: "Optional fixed issuer URL (overrides Host-based detection).",
		},
	}
}

// EnsureDefaults writes default values to app_config for keys that are not yet
// present. Idempotent.
func EnsureDefaults(db *sql.DB) error {
	for _, k := range DefaultConfig() {
		var existing string
		err := db.QueryRow("SELECT value FROM app_config WHERE `key` = ?", k.Key).Scan(&existing)
		if err == sql.ErrNoRows {
			if _, err := db.Exec("INSERT INTO app_config (`key`, value) VALUES (?, ?)", k.Key, k.DefaultVal); err != nil {
				return fmt.Errorf("oauth: insert default %s: %w", k.Key, err)
			}
		} else if err != nil {
			return fmt.Errorf("oauth: read %s: %w", k.Key, err)
		}
	}
	return nil
}

// IsOAuthEnabled returns true unless oauth_enabled is explicitly "0".
func IsOAuthEnabled(db *sql.DB) bool {
	var val string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'oauth_enabled'").Scan(&val); err != nil {
		return true
	}
	return val != "0"
}

// SetConfig updates a single OAuth config key. Returns an error for unknown
// keys so the admin UI cannot typo arbitrary keys into app_config.
func SetConfig(db *sql.DB, key, value string) error {
	for _, k := range DefaultConfig() {
		if k.Key == key {
			_, err := db.Exec("REPLACE INTO app_config (`key`, value) VALUES (?, ?)", key, value)
			return err
		}
	}
	return fmt.Errorf("oauth: unknown config key %q", key)
}

// GetConfigMap returns the current OAuth config as a key/value map. Missing
// keys fall back to defaults.
func GetConfigMap(db *sql.DB) (map[string]string, error) {
	out := make(map[string]string, 16)
	for _, k := range DefaultConfig() {
		out[k.Key] = k.DefaultVal
	}
	rows, err := db.Query("SELECT `key`, value FROM app_config WHERE `key` LIKE 'oauth_%' OR `key` IN ('jwt_signing_kid', 'jwt_signing_key')")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}