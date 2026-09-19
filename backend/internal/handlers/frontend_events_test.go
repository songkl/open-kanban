package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/handlers"
)

// setupFrontendEventsDB creates a minimal in-memory SQLite
// database with just the users / tokens / app_config tables
// the frontend-events handler touches. We avoid the larger
// auth_test.go setupTestDB helper because that schema pulls in
// the full activities / boards / columns / permissions
// machinery that the ingest endpoint does not need, and
// keeping the helper local makes the test file self-contained
// for future maintainers reading the redaction logic in
// isolation.
func setupFrontendEventsDB(t *testing.T) *sql.DB {
	t.Helper()
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
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
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	CREATE TABLE frontend_events (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		event_type TEXT NOT NULL,
		message TEXT,
		stack TEXT,
		url TEXT,
		source TEXT,
		details TEXT,
		received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, enabled) VALUES
		('admin1', 'admin', 'Admin', '', 'ADMIN', 1),
		('member1', 'bob', 'Bob', '', 'MEMBER', 1)`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES
		('t-admin', 'admin1', 'token-admin'),
		('t-member', 'member1', 'token-member')`); err != nil {
		t.Fatalf("seed tokens: %v", err)
	}
	// Enable auth so RequireAuth + OptionalAuth both resolve the
	// session cookie. The ingest endpoint sits BEHIND the auth
	// gate (the route is wrapped by OptionalAuth in main.go).
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`); err != nil {
		t.Fatalf("seed authEnabled: %v", err)
	}

	return db
}

// newFrontendEventsRouter mounts only the routes that the
// main.go change introduces. The optional-auth wrapper on the
// POST mirrors the production wiring so the redaction tests
// exercise the real handler chain.
func newFrontendEventsRouter(db *sql.DB) *gin.Engine {
	router := gin.New()
	router.POST("/api/v1/frontend-events", handlers.OptionalAuth(db), handlers.IngestFrontendEvent(db))
	router.GET("/api/v1/frontend-events", handlers.RequireAuth(db), handlers.ListFrontendEvents(db))
	router.GET("/api/v1/frontend-events/config", handlers.RequireAuth(db), handlers.GetFrontendEventsEnabled(db))
	return router
}

func doFrontendEventsRequest(t *testing.T, router *gin.Engine, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, path, reader)
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

// TestIngestFrontendEvent_HappyPath pins the DoD: an unhandled
// exception in the frontend produces a persisted event with
// stack + URL + user_id. Verifies that the row reaches the
// `frontend_events` table with every field populated as
// expected.
func TestIngestFrontendEvent_HappyPath(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{
		"eventType": "error",
		"message": "TypeError: x is not a function",
		"stack": "TypeError: x is not a function\n    at BoardPage (board.js:42:13)",
		"url": "http://localhost/board/gbk",
		"source": "board.js:42:13",
		"details": {"componentStack": "at BoardPage"}
	}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID == "" {
		t.Fatalf("expected non-empty id in response, got empty string")
	}

	var (
		userID    sql.NullString
		eventType string
		message   string
		stack     string
		url       string
		source    string
		details   sql.NullString
	)
	if err := db.QueryRow(
		`SELECT user_id, event_type, message, stack, url, source, details FROM frontend_events WHERE id = ?`,
		resp.ID,
	).Scan(&userID, &eventType, &message, &stack, &url, &source, &details); err != nil {
		t.Fatalf("scan row: %v", err)
	}
	if !userID.Valid || userID.String != "admin1" {
		t.Errorf("expected user_id=admin1, got %+v", userID)
	}
	if eventType != "error" {
		t.Errorf("expected event_type=error, got %q", eventType)
	}
	if !strings.Contains(message, "TypeError") {
		t.Errorf("expected message to contain 'TypeError', got %q", message)
	}
	if !strings.Contains(stack, "BoardPage") {
		t.Errorf("expected stack to contain 'BoardPage', got %q", stack)
	}
	if url != "http://localhost/board/gbk" {
		t.Errorf("expected url to round-trip, got %q", url)
	}
	if source != "board.js:42:13" {
		t.Errorf("expected source to round-trip, got %q", source)
	}
	if !strings.Contains(details.String, "componentStack") {
		t.Errorf("expected details to contain 'componentStack', got %q", details.String)
	}
}

// TestIngestFrontendEvent_PreLoginUser exercises the
// OptionalAuth contract. An unhandled exception during the
// pre-login setup flow has no associated user; the row still
// persists, just with a NULL user_id.
func TestIngestFrontendEvent_PreLoginUser(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{"eventType": "error", "message": "boom"}`)
	// No cookie => no session.
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for unauthenticated ingest, got %d: %s", w.Code, w.Body.String())
	}

	var id string
	if err := db.QueryRow(`SELECT id FROM frontend_events LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("scan id: %v", err)
	}

	var userID sql.NullString
	if err := db.QueryRow(`SELECT user_id FROM frontend_events WHERE id = ?`, id).Scan(&userID); err != nil {
		t.Fatalf("scan user_id: %v", err)
	}
	if userID.Valid {
		t.Errorf("expected user_id to be NULL for pre-login event, got %q", userID.String)
	}
}

// TestIngestFrontendEvent_DisabledReturnsNoContent pins the
// admin toggle (Settings → Error Reporting → off): when the
// sink is disabled the endpoint returns 204 with no row
// written, which the frontend's global handler treats as
// "all good, nothing to do".
func TestIngestFrontendEvent_DisabledReturnsNoContent(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('frontendEventsEnabled', '0')`); err != nil {
		t.Fatalf("seed disabled flag: %v", err)
	}
	router := newFrontendEventsRouter(db)

	body := []byte(`{"eventType": "error", "message": "boom"}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when sink is disabled, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM frontend_events`).Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if count != 0 {
		t.Errorf("expected zero rows when sink is disabled, got %d", count)
	}
}

// TestIngestFrontendEvent_RejectsUnknownEventType pins the
// allow-list: an unknown eventType is rejected at 400, never
// reaching the database. The endpoint cannot be used as a
// junk-row generator.
func TestIngestFrontendEvent_RejectsUnknownEventType(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{"eventType": "totally made up", "message": "boom"}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown eventType, got %d: %s", w.Code, w.Body.String())
	}
}

// TestIngestFrontendEvent_RejectsBadJSON pins the JSON syntax
// error contract: malformed body returns 400, not 500, so the
// global handler does not crash on a corrupted payload.
func TestIngestFrontendEvent_RejectsBadJSON(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", []byte(`{not json`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed JSON, got %d: %s", w.Code, w.Body.String())
	}
}

// TestIngestFrontendEvent_AcceptsEveryEventType pins the
// allow-list exhaustive contract: every documented eventType
// must round-trip. A future maintainer that accidentally
// removes an entry from frontendEventType will trip this test
// and be forced to make a deliberate choice.
func TestIngestFrontendEvent_AcceptsEveryEventType(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	for _, eventType := range []string{"error", "unhandled_rejection", "react_error", "console_error", "resource_404"} {
		t.Run(eventType, func(t *testing.T) {
			body := []byte(`{"eventType":"` + eventType + `","message":"boom"}`)
			w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
			if w.Code != http.StatusOK {
				t.Fatalf("expected 200 for %s, got %d: %s", eventType, w.Code, w.Body.String())
			}
		})
	}
}

// TestRedactString_RemovesAuthorizationHeader is the core
// redaction guarantee: an `Authorization: Bearer …` substring
// in the captured message must NEVER reach the database. The
// substring is replaced with `[REDACTED]` so a future log
// reader can still see that a token WAS present.
func TestRedactString_RemovesAuthorizationHeader(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "bearer token",
			in:   "request failed: Authorization: Bearer abc.def.ghi",
			want: "request failed: Authorization: Bearer [REDACTED]",
		},
		{
			name: "basic auth",
			in:   "Authorization: Basic dXNlcjpwYXNz",
			want: "Authorization: Basic [REDACTED]",
		},
		{
			name: "case insensitive",
			in:   "AUTHORIZATION: bearer abc",
			want: "AUTHORIZATION: bearer [REDACTED]",
		},
		{
			name: "no leak when absent",
			in:   "TypeError: x is not a function",
			want: "TypeError: x is not a function",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// redacted through the public surface (message
			// field) — the same path the IngestFrontendEvent
			// handler runs against every captured string.
			body := []byte(`{"eventType":"error","message":"` + tc.in + `"}`)
			db := setupFrontendEventsDB(t)
			defer db.Close()
			router := newFrontendEventsRouter(db)

			w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
			if w.Code != http.StatusOK {
				t.Fatalf("ingest failed: %d %s", w.Code, w.Body.String())
			}

			var got string
			if err := db.QueryRow(`SELECT message FROM frontend_events ORDER BY received_at DESC LIMIT 1`).Scan(&got); err != nil {
				t.Fatalf("scan message: %v", err)
			}
			if got != tc.want {
				t.Errorf("redaction mismatch\nwant: %q\ngot:  %q", tc.want, got)
			}
			if strings.Contains(got, "abc.def.ghi") || strings.Contains(got, "dXNlcjpwYXNz") {
				t.Errorf("token leaked into persisted message: %q", got)
			}
		})
	}
}

// TestRedactString_RemovesKanbanTokenCookie pins the
// cookie-shaped redaction: a `kanban-token=…` substring (the
// only authentication cookie the app issues) must NEVER reach
// the database. Cookies without that name are not redacted
// because they are not authentication material.
func TestRedactString_RemovesKanbanTokenCookie(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{
		"eventType": "error",
		"message": "fetch failed because Cookie: kanban-token=secret-cookie-value",
		"stack": "kanban-token=stack-cookie-value\n    at foo",
		"details": {"cookie":"kanban-token=details-cookie-value"}
	}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest failed: %d %s", w.Code, w.Body.String())
	}

	var (
		message sql.NullString
		stack   sql.NullString
		details sql.NullString
	)
	if err := db.QueryRow(`SELECT message, stack, details FROM frontend_events ORDER BY received_at DESC LIMIT 1`).
		Scan(&message, &stack, &details); err != nil {
		t.Fatalf("scan: %v", err)
	}
	for label, raw := range map[string]string{"message": message.String, "stack": stack.String, "details": details.String} {
		if strings.Contains(raw, "secret-cookie-value") ||
			strings.Contains(raw, "stack-cookie-value") ||
			strings.Contains(raw, "details-cookie-value") {
			t.Errorf("kanban-token value leaked into %s: %q", label, raw)
		}
		if !strings.Contains(raw, "[REDACTED]") {
			t.Errorf("expected %s to contain [REDACTED] marker, got %q", label, raw)
		}
	}
}

// TestRedactString_RemovesQueryStringTokens pins the
// `?token=…` / `?api_key=…` redaction. The global handler
// sometimes captures the failing URL in the message field
// when a fetch() rejects; query-string credentials in those
// URLs must not leak.
func TestRedactString_RemovesQueryStringTokens(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{"eventType":"error","message":"fetch /api/v1/boards?token=alpha&api_key=beta failed"}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest failed: %d %s", w.Code, w.Body.String())
	}

	var got string
	if err := db.QueryRow(`SELECT message FROM frontend_events ORDER BY received_at DESC LIMIT 1`).Scan(&got); err != nil {
		t.Fatalf("scan message: %v", err)
	}
	if strings.Contains(got, "alpha") || strings.Contains(got, "beta") {
		t.Errorf("query token leaked into persisted message: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Errorf("expected [REDACTED] marker, got %q", got)
	}
}

// TestRedactString_RemovesJSONSecretKeys pins the JSON-shape
// redaction: `{"password":"…"}` / `{"apiKey":"…"}` /
// `{"clientSecret":"…"}` substrings must NEVER reach the row.
// The pattern is for the JSON key, NOT for free-form prose —
// the redaction passes are run on the captured `details` blob
// where embedded JSON is the common case.
func TestRedactString_RemovesJSONSecretKeys(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	body := []byte(`{
		"eventType": "error",
		"details": {"password":"hunter2","apiKey":"ABC123","clientSecret":"def456"}
	}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest failed: %d %s", w.Code, w.Body.String())
	}

	var details sql.NullString
	if err := db.QueryRow(`SELECT details FROM frontend_events ORDER BY received_at DESC LIMIT 1`).Scan(&details); err != nil {
		t.Fatalf("scan: %v", err)
	}
	for _, leaked := range []string{"hunter2", "ABC123", "def456"} {
		if strings.Contains(details.String, leaked) {
			t.Errorf("JSON secret value %q leaked into details: %q", leaked, details.String)
		}
	}
}

// TestIngestFrontendEvent_CapsMassiveMessage pins the
// per-field cap: a multi-megabyte message must NOT 500 the
// handler. The cap is enforced BEFORE the redaction pass so a
// runaway client cannot exhaust memory while running regexes
// against the input.
func TestIngestFrontendEvent_CapsMassiveMessage(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	// 60 KB of filler — well above the 4 KB message cap and
	// the per-field stack cap, but still inside the 64 KB
	// whole-body cap so the rejection happens on the field,
	// not on the whole request.
	oversizeMessage := strings.Repeat("a", 60*1024)
	body := []byte(`{"eventType":"error","message":"` + oversizeMessage + `"}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for capped message, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	if err := db.QueryRow(`SELECT message FROM frontend_events ORDER BY received_at DESC LIMIT 1`).Scan(&stored); err != nil {
		t.Fatalf("scan: %v", err)
	}
	// The cap is 4 KB on the message field. Allow some slack
	// for UTF-8 boundary trim so the assertion is deterministic.
	if len(stored) > 8*1024 {
		t.Errorf("expected stored message to be capped near 4KB, got %d bytes", len(stored))
	}
}

// TestIngestFrontendEvent_RejectsOversizedRequest pins the
// whole-body cap: a 1 MB body is rejected at the API
// boundary so a runaway client cannot exhaust server memory.
func TestIngestFrontendEvent_RejectsOversizedRequest(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	oversize := bytes.Repeat([]byte("a"), 1024*1024)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", oversize)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d: %s", w.Code, w.Body.String())
	}
}

// TestListFrontendEvents_AdminOnly pins the audit surface
// gate: only global admins can list captured events, because
// the payload carries stack traces and user identifiers.
func TestListFrontendEvents_AdminOnly(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	// Seed a row to make sure the "empty list" case is not
	// what's being tested.
	if _, err := db.Exec(
		`INSERT INTO frontend_events (id, event_type, message) VALUES ('e1', 'error', 'boom')`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Non-admin member => 403.
	w := doFrontendEventsRequest(t, router, "GET", "/api/v1/frontend-events", "token-member", nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-admin list, got %d: %s", w.Code, w.Body.String())
	}

	// Admin => 200 with the seeded row visible.
	w = doFrontendEventsRequest(t, router, "GET", "/api/v1/frontend-events", "token-admin", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin list, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Events []map[string]any `json:"events"`
		Total  int              `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 1 {
		t.Errorf("expected 1 event, got %d", resp.Total)
	}
	if len(resp.Events) != 1 || resp.Events[0]["id"] != "e1" {
		t.Errorf("expected event id=e1, got %+v", resp.Events)
	}
}

// TestSetFrontendEventsEnabled_RoundTrip pins the
// Settings toggle contract: PUT /api/v1/frontend-events/config
// flips the flag, and the next ingest observes the new value.
// Admin-only by the same rule as the list endpoint.
func TestSetFrontendEventsEnabled_RoundTrip(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()

	router := gin.New()
	router.PUT("/api/v1/frontend-events/config", handlers.SetFrontendEventsEnabled(db))

	// Flip to disabled.
	w := doFrontendEventsRequest(t, router, "PUT", "/api/v1/frontend-events/config", "token-admin",
		[]byte(`{"enabled": false}`))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// And the read endpoint reflects it.
	readRouter := gin.New()
	readRouter.GET("/api/v1/frontend-events/config", handlers.RequireAuth(db), handlers.GetFrontendEventsEnabled(db))
	w = doFrontendEventsRequest(t, readRouter, "GET", "/api/v1/frontend-events/config", "token-admin", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on read, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Enabled {
		t.Errorf("expected enabled=false after disable, got true")
	}

	// And the ingest endpoint now returns 204 (no row).
	postRouter := gin.New()
	postRouter.POST("/api/v1/frontend-events", handlers.OptionalAuth(db), handlers.IngestFrontendEvent(db))
	w = doFrontendEventsRequest(t, postRouter, "POST", "/api/v1/frontend-events", "token-admin",
		[]byte(`{"eventType":"error","message":"boom"}`))
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 after disable, got %d: %s", w.Code, w.Body.String())
	}

	// Non-admin cannot flip the flag.
	w = doFrontendEventsRequest(t, router, "PUT", "/api/v1/frontend-events/config", "token-member",
		[]byte(`{"enabled": true}`))
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-admin update, got %d: %s", w.Code, w.Body.String())
	}
}

// TestTruncateToUtf8Bytes pins the UTF-8-aware truncation
// helper. A multi-byte rune at the cap boundary must be
// dropped whole so the stored message is always valid UTF-8
// (which sanitizeString requires on the way to the database).
// We exercise the helper indirectly: send a stack that
// includes a multi-byte character right at the cap boundary,
// then read it back and confirm the stored value is well-formed.
func TestTruncateToUtf8Bytes(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	// Build a stack that is exactly 32 KB long (the stack
	// cap) with a multi-byte rune ("é") straddling the cap
	// boundary. The handler should truncate to the last
	// rune-start before 32 KB so the stored stack is still
	// valid UTF-8.
	prefix := strings.Repeat("a", 32*1024-2)
	stack := prefix + "é" + strings.Repeat("b", 200)
	body := []byte(`{"eventType":"error","message":"hi","stack":"` + stack + `"}`)
	w := doFrontendEventsRequest(t, router, "POST", "/api/v1/frontend-events", "token-admin", body)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest failed: %d %s", w.Code, w.Body.String())
	}

	var stored sql.NullString
	if err := db.QueryRow(`SELECT stack FROM frontend_events ORDER BY received_at DESC LIMIT 1`).Scan(&stored); err != nil {
		t.Fatalf("scan: %v", err)
	}
	// Stored value must be within the cap (allow a small
	// overshoot for the UTF-8 boundary walk) and must be
	// valid UTF-8.
	if len(stored.String) > 32*1024 {
		t.Errorf("stored stack should be capped near 32KB, got %d bytes", len(stored.String))
	}
	if !utf8.ValidString(stored.String) {
		t.Errorf("stored stack must be valid UTF-8, got %q", stored.String)
	}
}

// TestParseLimitParam_RejectsOutOfRange pins the list-endpoint
// limit parser. Anything outside [1, 100] is silently clamped
// (or ignored) so a typo cannot turn into an unbounded
// SELECT. We pin the silent-ignore behaviour here so a future
// maintainer has to make a deliberate choice to surface 400.
func TestParseLimitParam_RejectsOutOfRange(t *testing.T) {
	db := setupFrontendEventsDB(t)
	defer db.Close()
	router := newFrontendEventsRouter(db)

	w := doFrontendEventsRequest(t, router, "GET", "/api/v1/frontend-events?limit=99999", "token-admin", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (silent clamp), got %d: %s", w.Code, w.Body.String())
	}
	w = doFrontendEventsRequest(t, router, "GET", "/api/v1/frontend-events?limit=abc", "token-admin", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (silent ignore), got %d: %s", w.Code, w.Body.String())
	}
}
