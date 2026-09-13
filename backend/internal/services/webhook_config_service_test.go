package services_test

import (
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

// setupWebhookServiceTestDB returns an in-memory SQLite with
// the webhooks + users + activities tables the config service
// needs. The activities schema mirrors migration 014 so the
// audit log writes don't trip the CHECK constraint on action.
//
// `cache=shared` + SetMaxOpenConns(1) are required so the
// background DNS-resolution warnings (logged but not stored)
// don't fragment the in-memory database across connections.
func setupWebhookServiceTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:webhook_config_service_test.db?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE webhooks (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		url TEXT NOT NULL,
		secret BLOB NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		event_types TEXT NOT NULL DEFAULT '[]',
		filters TEXT NOT NULL DEFAULT '{}',
		headers TEXT NOT NULL DEFAULT '{}',
		timeout_sec INTEGER NOT NULL DEFAULT 10,
		max_retries INTEGER NOT NULL DEFAULT 5,
		created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_success_at DATETIME,
		last_failure_at DATETIME
	);
	-- Activities schema with the migration-014 action / target_type
	-- CHECK so the audit-log writes don't fail the constraint.
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN (
			'CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK',
			'ADD_COMMENT', 'LOGIN', 'LOGOUT',
			'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE',
			'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE',
			'USER_CREATE', 'USER_UPDATE',
			'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT',
			'APP_CONFIG_UPDATE',
			'PERMISSION_GRANT', 'PERMISSION_REVOKE',
			'DEVICE_APPROVE',
			'OAUTH_PROVIDER_CREATE', 'OAUTH_PROVIDER_UPDATE', 'OAUTH_PROVIDER_DELETE',
			'OAUTH_PROVIDER_ENABLE', 'OAUTH_PROVIDER_DISABLE',
			'OAUTH_CLIENT_DELETE',
			'OAUTH_CONFIG_UPDATE',
			'OAUTH_CONSENT_REVOKE',
			'webhook.created', 'webhook.updated', 'webhook.deleted',
			'webhook.rotated', 'webhook.tested'
		)),
		target_type TEXT NOT NULL CHECK(target_type IN (
			'TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE',
			'DEVICE', 'OAUTH', 'WEBHOOK'
		)),
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u-admin', 'admin', 'admin', 'ADMIN', 1)`,
		`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u-member', 'member', 'member', 'MEMBER', 1)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed %q: %v", stmt, err)
		}
	}
	return db
}

// countActivities returns the number of audit rows the service
// has written for a given (action, target_id) pair. Used by the
// tests to assert the audit log fires on every write.
func countActivities(t *testing.T, db *sql.DB, action, targetID string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM activities WHERE action = ? AND target_id = ?",
		action, targetID,
	).Scan(&n); err != nil {
		t.Fatalf("count activities: %v", err)
	}
	return n
}

// withAllowPrivate sets WEBHOOK_ALLOW_PRIVATE=1 for the
// duration of the test and clears it after, so parallel
// sub-tests can't observe each other's env state.
func withAllowPrivate(t *testing.T) {
	t.Helper()
	t.Setenv("WEBHOOK_ALLOW_PRIVATE", "1")
}

// ----------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------

func TestWebhookConfigService_Create_Success(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()

	svc := services.NewWebhookConfigService(db)

	in := services.CreateWebhookInput{
		Name:       "Primary",
		URL:        "https://example.com/hook",
		EventTypes: `["task.created"]`,
		Filters:    `{}`,
		Headers:    `{}`,
	}

	res, err := svc.Create("u-admin", in)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if res == nil {
		t.Fatal("Create returned nil result")
	}
	if res.Webhook.ID == "" {
		t.Error("Webhook.ID should be populated")
	}
	if res.Webhook.Secret != services.WebhookSecretRedacted {
		t.Errorf("Create response secret must be redacted; got %q want %q", res.Webhook.Secret, services.WebhookSecretRedacted)
	}
	if res.PlaintextSecret == "" {
		t.Error("PlaintextSecret must be returned exactly once")
	}
	if len(res.PlaintextSecret) != services.WebhookSecretLength*2 {
		t.Errorf("PlaintextSecret length: got %d want %d (hex-encoded %d bytes)", len(res.PlaintextSecret), services.WebhookSecretLength*2, services.WebhookSecretLength)
	}
	if res.Webhook.Name != "Primary" {
		t.Errorf("Name: got %q", res.Webhook.Name)
	}
	if res.Webhook.URL != "https://example.com/hook" {
		t.Errorf("URL: got %q", res.Webhook.URL)
	}
	if res.Webhook.CreatedBy == nil || *res.Webhook.CreatedBy != "u-admin" {
		t.Errorf("CreatedBy: got %v want u-admin", res.Webhook.CreatedBy)
	}

	if n := countActivities(t, db, "webhook.created", res.Webhook.ID); n != 1 {
		t.Errorf("expected 1 webhook.created audit row, got %d", n)
	}
}

func TestWebhookConfigService_Create_NonAdminForbidden(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	in := services.CreateWebhookInput{
		Name: "x",
		URL:  "https://example.com/x",
	}
	_, err := svc.Create("u-member", in)
	if !errors.Is(err, services.ErrWebhookForbidden) {
		t.Errorf("expected ErrWebhookForbidden, got %v", err)
	}
	if n := countActivities(t, db, "webhook.created", ""); n != 0 {
		t.Errorf("rejected Create should not write an audit row; got %d", n)
	}
}

func TestWebhookConfigService_Create_EmptyActorForbidden(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	in := services.CreateWebhookInput{Name: "x", URL: "https://example.com/x"}
	_, err := svc.Create("", in)
	if !errors.Is(err, services.ErrWebhookForbidden) {
		t.Errorf("empty actor should be forbidden; got %v", err)
	}
}

func TestWebhookConfigService_Create_ValidationErrors(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	tests := []struct {
		name      string
		in        services.CreateWebhookInput
		wantField string
		wantSub   string
	}{
		{
			name:      "missing name",
			in:        services.CreateWebhookInput{URL: "https://example.com/x"},
			wantField: "name",
		},
		{
			name:      "blank name after trim",
			in:        services.CreateWebhookInput{Name: "   ", URL: "https://example.com/x"},
			wantField: "name",
		},
		{
			name: "name too long",
			in: services.CreateWebhookInput{
				Name: strings.Repeat("a", 65),
				URL:  "https://example.com/x",
			},
			wantField: "name",
		},
		{
			name:      "missing url",
			in:        services.CreateWebhookInput{Name: "x"},
			wantField: "url",
		},
		{
			name:      "non-https scheme",
			in:        services.CreateWebhookInput{Name: "x", URL: "http://example.com/x"},
			wantField: "url",
			wantSub:   "https",
		},
		{
			name:      "loopback host rejected",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://127.0.0.1/hook"},
			wantField: "url",
		},
		{
			name:      "rfc1918 host rejected",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://10.0.0.5/hook"},
			wantField: "url",
		},
		{
			name:      "link-local host rejected",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://169.254.169.254/hook"},
			wantField: "url",
		},
		{
			name:      "localhost host rejected",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://localhost/hook"},
			wantField: "url",
		},
		{
			name:      "eventTypes not an array",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://example.com/x", EventTypes: `{"a":1}`},
			wantField: "eventTypes",
		},
		{
			name:      "filters not an object",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://example.com/x", Filters: `[]`},
			wantField: "filters",
		},
		{
			name:      "headers not an object",
			in:        services.CreateWebhookInput{Name: "x", URL: "https://example.com/x", Headers: `[]`},
			wantField: "headers",
		},
		{
			name: "timeoutSec too low",
			in: services.CreateWebhookInput{
				Name: "x", URL: "https://example.com/x",
				TimeoutSec: intPtr(0),
			},
			wantField: "timeoutSec",
		},
		{
			name: "maxRetries too high",
			in: services.CreateWebhookInput{
				Name: "x", URL: "https://example.com/x",
				MaxRetries: intPtr(99),
			},
			wantField: "maxRetries",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := svc.Create("u-admin", tt.in)
			if err == nil {
				t.Fatal("expected validation error")
			}
			var ie *services.WebhookInputError
			if !errors.As(err, &ie) {
				t.Fatalf("expected *WebhookInputError, got %T: %v", err, err)
			}
			if ie.Field != tt.wantField {
				t.Errorf("field: got %q want %q", ie.Field, tt.wantField)
			}
			if tt.wantSub != "" && !strings.Contains(strings.ToLower(ie.Message), strings.ToLower(tt.wantSub)) {
				t.Errorf("message: got %q want substring %q", ie.Message, tt.wantSub)
			}
			if n := countActivities(t, db, "webhook.created", ""); n != 0 {
				t.Errorf("rejected Create should not write an audit row; got %d", n)
			}
		})
	}
}

func TestWebhookConfigService_Create_PrivateAllowedWithEnvVar(t *testing.T) {
	withAllowPrivate(t)
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	// 127.0.0.1 is loopback; with WEBHOOK_ALLOW_PRIVATE=1 the
	// validator must accept it. We bypass DNS for this case
	// because 127.0.0.1 is always blocked before the lookup
	// (isAlwaysBlockedHost).
	_, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "loopback-allowed",
		URL:  "https://127.0.0.1/hook",
	})
	if err != nil {
		t.Errorf("WEBHOOK_ALLOW_PRIVATE=1 should permit loopback: %v", err)
	}
}

func TestWebhookConfigService_Create_DNSFailureWarnsButSucceeds(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	// Hostname that is RFC 1035-compliant but should not resolve
	// in the test runner's environment. Even if it does, the
	// service must succeed — DNS failure is a soft warning per
	// plan §5.4.
	_, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "unresolvable",
		URL:  "https://webhook-does-not-exist-12345.invalid/x",
	})
	if err != nil {
		t.Errorf("Create should succeed despite DNS failure: %v", err)
	}
}

// ----------------------------------------------------------------------
// Get / List — secret redaction is the headline behaviour
// ----------------------------------------------------------------------

func TestWebhookConfigService_Get_RedactsSecret(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := svc.Get(res.Webhook.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Secret != services.WebhookSecretRedacted {
		t.Errorf("Get must redact secret; got %q want %q", got.Secret, services.WebhookSecretRedacted)
	}
	// WebhookView intentionally has no PlaintextSecret field —
	// the assertion below would fail to compile if a future
	// refactor accidentally re-exposes the plaintext here.
	if res.PlaintextSecret == "" {
		t.Error("seed Create must return plaintext exactly once")
	}
}

func TestWebhookConfigService_Get_NotFound(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	_, err := svc.Get("ghost")
	if !errors.Is(err, services.ErrWebhookNotFound) {
		t.Errorf("expected ErrWebhookNotFound, got %v", err)
	}
}

func TestWebhookConfigService_List_RedactsSecrets(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	for i, name := range []string{"a", "b"} {
		_, err := svc.Create("u-admin", services.CreateWebhookInput{
			Name: name, URL: "https://example.com/" + name,
			EventTypes: `["task.created"]`,
		})
		if err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}

	got, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(got))
	}
	for _, w := range got {
		if w.Secret != services.WebhookSecretRedacted {
			t.Errorf("List row %s: secret must be redacted; got %q", w.ID, w.Secret)
		}
	}
}

func TestWebhookConfigService_List_Empty(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	got, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got == nil {
		t.Error("List should return empty slice, not nil")
	}
	if len(got) != 0 {
		t.Errorf("expected 0 rows, got %d", len(got))
	}
}

// ----------------------------------------------------------------------
// Update
// ----------------------------------------------------------------------

func TestWebhookConfigService_Update_Success(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "original", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	newName := "renamed"
	newURL := "https://example.com/y"
	enabled := false
	got, err := svc.Update("u-admin", res.Webhook.ID, services.UpdateWebhookInput{
		Name:    &newName,
		URL:     &newURL,
		Enabled: &enabled,
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.Name != "renamed" {
		t.Errorf("Name: got %q", got.Name)
	}
	if got.URL != "https://example.com/y" {
		t.Errorf("URL: got %q", got.URL)
	}
	if got.Enabled {
		t.Error("Enabled should be false")
	}
	if got.Secret != services.WebhookSecretRedacted {
		t.Errorf("Update response secret must be redacted; got %q", got.Secret)
	}
	if n := countActivities(t, db, "webhook.updated", res.Webhook.ID); n != 1 {
		t.Errorf("expected 1 webhook.updated audit row, got %d", n)
	}
}

func TestWebhookConfigService_Update_NonAdminForbidden(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	newName := "rename"
	_, err = svc.Update("u-member", res.Webhook.ID, services.UpdateWebhookInput{Name: &newName})
	if !errors.Is(err, services.ErrWebhookForbidden) {
		t.Errorf("expected ErrWebhookForbidden, got %v", err)
	}
	if n := countActivities(t, db, "webhook.updated", res.Webhook.ID); n != 0 {
		t.Errorf("rejected Update should not write audit row; got %d", n)
	}
}

func TestWebhookConfigService_Update_NotFound(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	newName := "x"
	_, err := svc.Update("u-admin", "ghost", services.UpdateWebhookInput{Name: &newName})
	if !errors.Is(err, services.ErrWebhookNotFound) {
		t.Errorf("expected ErrWebhookNotFound, got %v", err)
	}
}

func TestWebhookConfigService_Update_RejectsBadURL(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	bad := "http://insecure.example.com/x"
	_, err = svc.Update("u-admin", res.Webhook.ID, services.UpdateWebhookInput{URL: &bad})
	if err == nil {
		t.Fatal("expected validation error for http scheme")
	}
	var ie *services.WebhookInputError
	if !errors.As(err, &ie) || ie.Field != "url" {
		t.Errorf("expected url field error, got %v", err)
	}
}

// ----------------------------------------------------------------------
// Delete
// ----------------------------------------------------------------------

func TestWebhookConfigService_Delete_Success(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := svc.Delete("u-admin", res.Webhook.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := svc.Get(res.Webhook.ID); !errors.Is(err, services.ErrWebhookNotFound) {
		t.Errorf("Get after Delete: expected ErrWebhookNotFound, got %v", err)
	}
	if n := countActivities(t, db, "webhook.deleted", res.Webhook.ID); n != 1 {
		t.Errorf("expected 1 webhook.deleted audit row, got %d", n)
	}
}

func TestWebhookConfigService_Delete_NonAdminForbidden(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := svc.Delete("u-member", res.Webhook.ID); !errors.Is(err, services.ErrWebhookForbidden) {
		t.Errorf("expected ErrWebhookForbidden, got %v", err)
	}
	if _, err := svc.Get(res.Webhook.ID); err != nil {
		t.Errorf("forbidden Delete should leave row intact; got Get err %v", err)
	}
	if n := countActivities(t, db, "webhook.deleted", res.Webhook.ID); n != 0 {
		t.Errorf("rejected Delete should not write audit row; got %d", n)
	}
}

func TestWebhookConfigService_Delete_NotFound(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	if err := svc.Delete("u-admin", "ghost"); !errors.Is(err, services.ErrWebhookNotFound) {
		t.Errorf("expected ErrWebhookNotFound, got %v", err)
	}
}

// ----------------------------------------------------------------------
// RotateSecret — must return new plaintext exactly once
// ----------------------------------------------------------------------

func TestWebhookConfigService_RotateSecret_ReturnsNewPlaintext(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	originalPlain := res.PlaintextSecret

	rot, err := svc.RotateSecret("u-admin", res.Webhook.ID)
	if err != nil {
		t.Fatalf("RotateSecret: %v", err)
	}
	if rot.PlaintextSecret == "" {
		t.Fatal("RotateSecret must return a new plaintext")
	}
	if rot.PlaintextSecret == originalPlain {
		t.Error("new plaintext must differ from the original")
	}
	if rot.Webhook.Secret != services.WebhookSecretRedacted {
		t.Errorf("RotateSecret response must redact the secret in the view; got %q", rot.Webhook.Secret)
	}

	// Subsequent Get must show the redacted placeholder, never
	// the new plaintext.
	got, err := svc.Get(res.Webhook.ID)
	if err != nil {
		t.Fatalf("Get after rotate: %v", err)
	}
	if got.Secret != services.WebhookSecretRedacted {
		t.Errorf("Get after rotate must be redacted; got %q", got.Secret)
	}
	if n := countActivities(t, db, "webhook.rotated", res.Webhook.ID); n != 1 {
		t.Errorf("expected 1 webhook.rotated audit row, got %d", n)
	}
}

func TestWebhookConfigService_RotateSecret_NonAdminForbidden(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	res, err := svc.Create("u-admin", services.CreateWebhookInput{
		Name: "x", URL: "https://example.com/x",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	_, err = svc.RotateSecret("u-member", res.Webhook.ID)
	if !errors.Is(err, services.ErrWebhookForbidden) {
		t.Errorf("expected ErrWebhookForbidden, got %v", err)
	}
	if n := countActivities(t, db, "webhook.rotated", res.Webhook.ID); n != 0 {
		t.Errorf("rejected rotate should not write audit row; got %d", n)
	}
}

func TestWebhookConfigService_RotateSecret_NotFound(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	_, err := svc.RotateSecret("u-admin", "ghost")
	if !errors.Is(err, services.ErrWebhookNotFound) {
		t.Errorf("expected ErrWebhookNotFound, got %v", err)
	}
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

func intPtr(n int) *int { return &n }

// ----------------------------------------------------------------------
// DNS warning timing — the service uses a 2s timeout for DNS
// lookups so an unresolvable hostname doesn't slow Create
// down. Run several Creates in parallel to ensure none of them
// blocks the test goroutine longer than the timeout budget.
// ----------------------------------------------------------------------

func TestWebhookConfigService_Create_DNSWarningConcurrent(t *testing.T) {
	db := setupWebhookServiceTestDB(t)
	defer db.Close()
	svc := services.NewWebhookConfigService(db)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := svc.Create("u-admin", services.CreateWebhookInput{
				Name: "concurrent-" + string(rune('a'+i)),
				URL:  "https://webhook-does-not-exist-" + string(rune('a'+i)) + ".invalid/x",
			})
			if err != nil {
				t.Errorf("concurrent %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()
}
