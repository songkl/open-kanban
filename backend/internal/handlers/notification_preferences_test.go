package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/handlers"
)

func setupNotificationPreferencesDB(t *testing.T) *sql.DB {
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
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
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		expires_at DATETIME,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE user_notification_preferences (
		user_id TEXT PRIMARY KEY,
		email_enabled INTEGER NOT NULL DEFAULT 1,
		webhook_enabled INTEGER NOT NULL DEFAULT 1,
		webhook_url TEXT NOT NULL DEFAULT '',
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, enabled) VALUES
		('admin1', 'admin', 'Admin', '', 'ADMIN', 1),
		('member1', 'bob', 'Bob', '', 'MEMBER', 1),
		('viewer1', 'carol', 'Carol', '', 'VIEWER', 1)`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES
		('t-admin', 'admin1', 'token-admin'),
		('t-member', 'member1', 'token-member'),
		('t-viewer', 'viewer1', 'token-viewer')`); err != nil {
		t.Fatalf("seed tokens: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`); err != nil {
		t.Fatalf("seed app_config: %v", err)
	}
	return db
}

func newNotificationPrefsRouter(db *sql.DB) *gin.Engine {
	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/v1/auth/me/notification-preferences", handlers.GetMyNotificationPreferences(db))
	router.PUT("/api/v1/auth/me/notification-preferences", handlers.UpdateMyNotificationPreferences(db))
	return router
}

func doNotificationPrefsRequest(t *testing.T, router *gin.Engine, method, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, "/api/v1/auth/me/notification-preferences", reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func decodeNotificationPrefs(t *testing.T, w *httptest.ResponseRecorder) handlers.NotificationPreferences {
	t.Helper()
	var prefs handlers.NotificationPreferences
	if err := json.Unmarshal(w.Body.Bytes(), &prefs); err != nil {
		t.Fatalf("decode: %v -- body=%s", err, w.Body.String())
	}
	return prefs
}

// TestGetNotificationPreferences_Default verifies the GET endpoint
// returns the documented defaults (email + webhook on, no URL) when
// the user has never saved a row. The Settings tab relies on this
// fallback so it doesn't have to special-case "first visit".
func TestGetNotificationPreferences_Default(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	w := doNotificationPrefsRequest(t, router, "GET", "token-member", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	prefs := decodeNotificationPrefs(t, w)
	if prefs.UserID != "member1" {
		t.Errorf("expected userId=member1, got %q", prefs.UserID)
	}
	if !prefs.EmailEnabled || !prefs.WebhookEnabled {
		t.Errorf("expected defaults enabled, got %+v", prefs)
	}
	if prefs.WebhookURL != "" {
		t.Errorf("expected empty webhookUrl, got %q", prefs.WebhookURL)
	}
	if prefs.UpdatedAt == "" {
		t.Errorf("expected non-empty updatedAt fallback")
	}
}

// TestGetNotificationPreferences_RequiresAuth pins the
// unauthenticated -> 401 contract: the endpoint sits behind
// RequireAuth so anonymous probes can never read preferences.
func TestGetNotificationPreferences_RequiresAuth(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	w := doNotificationPrefsRequest(t, router, "GET", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

// TestUpdateNotificationPreferences_PartialUpdate covers the
// partial-PUT contract: omitted fields are preserved, present fields
// overwrite. The Settings tab toggles one switch at a time, so a PUT
// that flips webhookEnabled cannot silently re-enable email.
func TestUpdateNotificationPreferences_PartialUpdate(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	// Seed an existing row so we can prove preserved fields.
	if _, err := db.Exec(
		`INSERT INTO user_notification_preferences (user_id, email_enabled, webhook_enabled, webhook_url)
		 VALUES ('member1', 0, 1, 'https://hooks.example.com/initial')`,
	); err != nil {
		t.Fatalf("seed prefs: %v", err)
	}

	// Only flip webhookEnabled; leave the rest alone.
	body := []byte(`{"webhookEnabled": false}`)
	w := doNotificationPrefsRequest(t, router, "PUT", "token-member", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	prefs := decodeNotificationPrefs(t, w)
	if prefs.EmailEnabled {
		t.Errorf("emailEnabled should be preserved (false), got true")
	}
	if prefs.WebhookEnabled {
		t.Errorf("webhookEnabled should be flipped to false, got true")
	}
	if prefs.WebhookURL != "https://hooks.example.com/initial" {
		t.Errorf("webhookUrl should be preserved, got %q", prefs.WebhookURL)
	}

	// And the persisted row matches.
	w = doNotificationPrefsRequest(t, router, "GET", "token-member", nil)
	persisted := decodeNotificationPrefs(t, w)
	if persisted.EmailEnabled || persisted.WebhookEnabled || persisted.WebhookURL != "https://hooks.example.com/initial" {
		t.Errorf("persisted row mismatch: %+v", persisted)
	}
}

// TestUpdateNotificationPreferences_RejectsBadURL pins the input
// validation: non-http(s) URLs are rejected at the API boundary so
// a typo (e.g. javascript:) cannot become a stored XSS payload.
func TestUpdateNotificationPreferences_RejectsBadURL(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	cases := []struct {
		name string
		url  string
	}{
		{"javascript scheme", "javascript:alert(1)"},
		{"data scheme", "data:text/html,<script>alert(1)</script>"},
		{"missing host", "https://"},
		{"file scheme", "file:///etc/passwd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte(`{"webhookUrl":"` + tc.url + `"}`)
			w := doNotificationPrefsRequest(t, router, "PUT", "token-admin", body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), "webhookUrl") {
				t.Errorf("expected error to mention webhookUrl, got %s", w.Body.String())
			}
		})
	}
}

// TestUpdateNotificationPreferences_AcceptsValidURL covers the
// happy path of URL validation: http(s) URLs with a host are
// accepted and persisted.
func TestUpdateNotificationPreferences_AcceptsValidURL(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	body := []byte(`{"webhookUrl":"https://hooks.example.com/path?token=abc"}`)
	w := doNotificationPrefsRequest(t, router, "PUT", "token-viewer", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	prefs := decodeNotificationPrefs(t, w)
	if prefs.WebhookURL != "https://hooks.example.com/path?token=abc" {
		t.Errorf("unexpected webhookUrl: %q", prefs.WebhookURL)
	}
}

// TestUpdateNotificationPreferences_EmptyURLClearsDestination makes
// sure an empty string is treated as "no destination" (and accepted),
// which is what the Settings tab sends when the user clears the
// webhook URL field.
func TestUpdateNotificationPreferences_EmptyURLClearsDestination(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO user_notification_preferences (user_id, webhook_url) VALUES ('admin1', 'https://old.example.com/hook')`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}
	router := newNotificationPrefsRouter(db)

	body := []byte(`{"webhookUrl":""}`)
	w := doNotificationPrefsRequest(t, router, "PUT", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	prefs := decodeNotificationPrefs(t, w)
	if prefs.WebhookURL != "" {
		t.Errorf("expected empty webhookUrl, got %q", prefs.WebhookURL)
	}
}

// TestUpdateNotificationPreferences_NonAdminCanWrite covers the
// non-admin gate: VIEWER / MEMBER / ADMIN can all write their own
// preferences. The admin-gating requirement (PM_REVIEW §3.7) is on
// the *menu*, not on the endpoint — every authenticated user owns
// their own row.
func TestUpdateNotificationPreferences_NonAdminCanWrite(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	for _, token := range []string{"token-admin", "token-member", "token-viewer"} {
		body := []byte(`{"emailEnabled":false}`)
		w := doNotificationPrefsRequest(t, router, "PUT", token, body)
		if w.Code != http.StatusOK {
			t.Fatalf("token %s: expected 200, got %d: %s", token, w.Code, w.Body.String())
		}
		prefs := decodeNotificationPrefs(t, w)
		if prefs.EmailEnabled {
			t.Errorf("token %s: emailEnabled should be false, got true", token)
		}
	}
}

// TestUpdateNotificationPreferences_RejectsBadJSON pins the JSON
// syntax error contract: a malformed body returns 400, not 500,
// so the Settings tab can surface a sensible toast.
func TestUpdateNotificationPreferences_RejectsBadJSON(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	router := newNotificationPrefsRouter(db)

	w := doNotificationPrefsRequest(t, router, "PUT", "token-admin", []byte(`{not json`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestNotificationPreferences_OtherUserCannotRead guards against
// cross-user enumeration: the endpoint is /auth/me, so the row is
// always the caller's. A non-admin must not be able to read another
// user's preferences via this endpoint (and there's no
// userID-in-path to try anyway).
func TestNotificationPreferences_OtherUserCannotRead(t *testing.T) {
	db := setupNotificationPreferencesDB(t)
	defer db.Close()
	// Pre-seed the admin row.
	if _, err := db.Exec(
		`INSERT INTO user_notification_preferences (user_id, webhook_url) VALUES ('admin1', 'https://secret.example.com/admin')`,
	); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	router := newNotificationPrefsRouter(db)

	// Member1 reads — should get THEIR OWN row, not the admin's.
	w := doNotificationPrefsRequest(t, router, "GET", "token-member", nil)
	prefs := decodeNotificationPrefs(t, w)
	if prefs.UserID != "member1" {
		t.Errorf("expected userId=member1, got %q", prefs.UserID)
	}
	if strings.Contains(prefs.WebhookURL, "secret") {
		t.Errorf("leaked another user's webhookUrl: %q", prefs.WebhookURL)
	}
}
