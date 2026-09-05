package handlers

import "testing"

// TestValidateAdvancedConfig_RejectsUnsupportedDBType verifies that the
// setup wizard's dbType is rejected when the running binary does not
// ship the corresponding driver. This is the defense-in-depth check
// behind the setup-page UI filter: even if a request bypasses the
// frontend (e.g. scripted /api/v1/auth/init call), the server will
// refuse to use a driver it can't actually open.
func TestValidateAdvancedConfig_RejectsUnsupportedDBType(t *testing.T) {
	// Pin the supported list via the test seam so we can drive the
	// test against any build variant. The init() in db.go / db_mysql.go
	// / db_sqlite.go has already populated the real list by the time
	// the test runs; we just override the indirection.
	original := supportedDBTypesForValidation
	t.Cleanup(func() { supportedDBTypesForValidation = original })

	tests := []struct {
		name        string
		supported   []string
		cfg         *AdvancedConfig
		wantOK      bool
		wantMsgFrag string
	}{
		{
			name:      "supported type (sqlite) passes",
			supported: []string{"mysql", "sqlite"},
			cfg:       &AdvancedConfig{DBType: "sqlite"},
			wantOK:    true,
		},
		{
			name:      "supported type (mysql) with full creds passes",
			supported: []string{"mysql", "sqlite"},
			cfg: &AdvancedConfig{
				DBType: "mysql",
				DBHost: "db",
				DBName: "kanban",
				DBUser: "u",
			},
			wantOK: true,
		},
		{
			name:        "unsupported type rejected",
			supported:   []string{"mysql"},
			cfg:         &AdvancedConfig{DBType: "sqlite"},
			wantOK:      false,
			wantMsgFrag: "sqlite",
		},
		{
			name:      "empty dbType passes (lets other defaults decide)",
			supported: []string{"mysql"},
			cfg:       &AdvancedConfig{DBType: ""},
			wantOK:    true,
		},
		{
			name:        "unknown dbType rejected",
			supported:   []string{"mysql", "sqlite"},
			cfg:         &AdvancedConfig{DBType: "postgres"},
			wantOK:      false,
			wantMsgFrag: "postgres",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			supportedDBTypesForValidation = func() []string { return tt.supported }
			msg, ok := validateAdvancedConfig(tt.cfg)
			if ok != tt.wantOK {
				t.Errorf("ok = %v, want %v (msg=%q)", ok, tt.wantOK, msg)
			}
			if !ok && tt.wantMsgFrag != "" && !contains(msg, tt.wantMsgFrag) {
				t.Errorf("expected error to mention %q, got %q", tt.wantMsgFrag, msg)
			}
		})
	}
}

func contains(s, sub string) bool {
	if sub == "" {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
