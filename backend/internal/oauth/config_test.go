package oauth_test

import (
	"testing"

	"open-kanban/internal/oauth"
)

func TestEnsureDefaultsIsIdempotent(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults second call: %v", err)
	}
	// Count: should be exactly len(DefaultConfig) rows
	rows, err := db.Query("SELECT `key`, value FROM app_config")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	seen := map[string]int{}
	for rows.Next() {
		var k, v string
		_ = rows.Scan(&k, &v)
		seen[k]++
	}
	for _, k := range oauth.DefaultConfig() {
		if seen[k.Key] != 1 {
			t.Errorf("expected exactly 1 row for %s, got %d", k.Key, seen[k.Key])
		}
	}
}

func TestEnsureDefaultsDoesNotOverwriteExisting(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('oauth_enabled', '0')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT value FROM app_config WHERE key = 'oauth_enabled'`).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "0" {
		t.Errorf("expected existing value preserved, got %s", got)
	}
}

func TestIsOAuthEnabled(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if !oauth.IsOAuthEnabled(db) {
		t.Error("expected default to be enabled")
	}
	if _, err := db.Exec(`UPDATE app_config SET value = '0' WHERE key = 'oauth_enabled'`); err != nil {
		t.Fatalf("update: %v", err)
	}
	if oauth.IsOAuthEnabled(db) {
		t.Error("expected disabled when value=0")
	}
}

func TestSetConfigRejectsUnknownKey(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.SetConfig(db, "oauth_typo_key", "1"); err == nil {
		t.Error("expected error for unknown key")
	}
}

func TestSetConfigUpdatesKnownKey(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if err := oauth.SetConfig(db, "oauth_access_token_ttl_seconds", "7200"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT value FROM app_config WHERE key = 'oauth_access_token_ttl_seconds'`).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "7200" {
		t.Errorf("expected 7200, got %s", got)
	}
}

func TestGetConfigMapReturnsAllDefaults(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	m, err := oauth.GetConfigMap(db)
	if err != nil {
		t.Fatalf("GetConfigMap: %v", err)
	}
	for _, k := range oauth.DefaultConfig() {
		if _, ok := m[k.Key]; !ok {
			t.Errorf("expected key %s in config map", k.Key)
		}
	}
	if v := m["oauth_enabled"]; v != "1" {
		t.Errorf("expected oauth_enabled=1, got %s", v)
	}
}

func TestDefaultConfigKeysAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, k := range oauth.DefaultConfig() {
		if seen[k.Key] {
			t.Errorf("duplicate key: %s", k.Key)
		}
		seen[k.Key] = true
		if k.Description == "" {
			t.Errorf("description for %s is empty", k.Key)
		}
	}
}

func TestPKCERequiredDefault(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT value FROM app_config WHERE key = 'oauth_require_pkce'`).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "1" {
		t.Errorf("expected PKCE required by default, got %s", got)
	}
}

func TestIsDeviceFlowEnabled(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if !oauth.IsDeviceFlowEnabled(db) {
		t.Error("expected default to be enabled")
	}
	if _, err := db.Exec(`UPDATE app_config SET value = '0' WHERE key = 'oauth_device_enabled'`); err != nil {
		t.Fatalf("update: %v", err)
	}
	if oauth.IsDeviceFlowEnabled(db) {
		t.Error("expected disabled when value=0")
	}
}

func TestDeviceFlowAgentID(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if got := oauth.DeviceFlowAgentID(db); got != "" {
		t.Errorf("expected empty default, got %q", got)
	}
	if _, err := db.Exec(`UPDATE app_config SET value = 'agent-7' WHERE key = 'oauth_device_agent_id'`); err != nil {
		t.Fatalf("update: %v", err)
	}
	if got := oauth.DeviceFlowAgentID(db); got != "agent-7" {
		t.Errorf("expected agent-7, got %q", got)
	}
}

// TestDeviceFlowRequiresAgentSelectionDefault ensures the
// oauth_device_require_agent_selection key is part of DefaultConfig
// (plan §4.1.4, s-1112.5) and that its default value disables the
// strict mode so existing self-service approvers keep working until
// admins opt in.
func TestDeviceFlowRequiresAgentSelectionDefault(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if oauth.DeviceFlowRequiresAgentSelection(db) {
		t.Error("expected strict mode disabled by default")
	}
	var got string
	if err := db.QueryRow(`SELECT value FROM app_config WHERE key = 'oauth_device_require_agent_selection'`).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "0" {
		t.Errorf("expected default value '0', got %q", got)
	}
}

// TestDeviceFlowRequiresAgentSelectionToggle covers the only flip the
// helper exposes — any value other than the literal "1" must keep
// the helper returning false so a typo ("yes", "true", "01") never
// accidentally turns the strict mode on.
func TestDeviceFlowRequiresAgentSelectionToggle(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	cases := []struct {
		val      string
		expected bool
	}{
		{"0", false},
		{"1", true},
		{"", false},
		{"true", false},
		{"yes", false},
		{" 1 ", true},
	}
	for _, tc := range cases {
		if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", tc.val); err != nil {
			t.Fatalf("SetConfig(%q): %v", tc.val, err)
		}
		if got := oauth.DeviceFlowRequiresAgentSelection(db); got != tc.expected {
			t.Errorf("value=%q expected %v, got %v", tc.val, tc.expected, got)
		}
	}
}
