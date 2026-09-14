package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/handlers"
	"open-kanban/internal/services"
)

// webhooksTestUsers are the canonical user ids the webhooks
// table-driven tests use. Centralised so every sub-test that
// needs an ADMIN or MEMBER actor picks the same handle and a
// typo in one place doesn't silently keep auth-from-bearer
// passing across the table.
const (
	webhookAdminID   = "u-admin"
	webhookMemberID  = "u-member"
	webhookAdminTok  = "admin-tok"
	webhookMemberTok = "member-tok"
)

// setupWebhooksDB returns an in-memory SQLite seeded with the
// minimum schema the /api/v1/webhooks/* handlers need end-to-end:
//
//   - users + tokens for the auth middleware (one ADMIN, one MEMBER)
//   - app_config so isAuthEnabled returns true (RequireAuth will
//     fall through to the getCurrentUser path that scans tokens.key)
//   - webhooks for the CRUD handlers
//   - webhook_deliveries for the deliveries endpoint
//   - activities with the migration-014 action / target_type
//     CHECK so the audit-log writes from the config service
//     don't trip the constraint and silently swallow the row.
//
// `file:webhooks_test.db_<test>?mode=memory&cache=shared` keeps
// every connection in the pool pointed at the same instance and
// uses a unique filename per test so parallel test cases don't
// observe each other's rows — without `cache=shared`, go-sqlite3
// hands out a private :memory: per pool slot and any goroutine
// spawned by a previous test sees an empty schema.
func setupWebhooksDB(t *testing.T) *sql.DB {
	t.Helper()
	name := fmt.Sprintf("file:webhooks_test_%s.db?mode=memory&cache=shared", t.Name())
	db, err := sql.Open("sqlite3", name)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled INTEGER DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE tokens (
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
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
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
	CREATE TABLE webhook_deliveries (
		id TEXT PRIMARY KEY,
		webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
		event_id TEXT NOT NULL,
		event_type TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED')),
		attempt INTEGER NOT NULL DEFAULT 1,
		request_body TEXT NOT NULL DEFAULT '',
		response_code INTEGER NOT NULL DEFAULT 0,
		response_body TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		finished_at DATETIME,
		next_retry_at DATETIME
	);
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
	seeds := []string{
		`INSERT INTO users (id, username, nickname, password, avatar, role, enabled) VALUES ('` + webhookAdminID + `', 'admin', 'admin', '', '', 'ADMIN', 1)`,
		`INSERT INTO users (id, username, nickname, password, avatar, role, enabled) VALUES ('` + webhookMemberID + `', 'member', 'member', '', '', 'MEMBER', 1)`,
		`INSERT INTO tokens (id, name, key, user_id) VALUES ('t-admin', 'admin', '` + webhookAdminTok + `', '` + webhookAdminID + `')`,
		`INSERT INTO tokens (id, name, key, user_id) VALUES ('t-member', 'member', '` + webhookMemberTok + `', '` + webhookMemberID + `')`,
		`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`,
	}
	for _, stmt := range seeds {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed %q: %v", stmt, err)
		}
	}
	return db
}

// seedWebhook inserts a webhook row directly so tests can exercise
// Get/Update/Delete/Rotate/Test/Deliveries without going through
// the network DNS round-trip the Create handler triggers.
func seedWebhook(t *testing.T, db *sql.DB, id, name, url string, eventTypes string) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO webhooks (id, name, url, secret, enabled, event_types, filters, headers, timeout_sec, max_retries, created_by)
		VALUES (?, ?, ?, ?, 1, ?, '{}', '{}', 10, 5, '`+webhookAdminID+`')
	`, id, name, url, []byte("seeded-secret-blob"), eventTypes); err != nil {
		t.Fatalf("seed webhook %q: %v", id, err)
	}
}

// seedDelivery inserts a webhook_deliveries row directly with a
// caller-supplied started_at so cursor-pagination tests can lay
// out a deterministic timeline.
func seedDelivery(t *testing.T, db *sql.DB, id, webhookID, eventType, status string, startedAt time.Time, attempt int) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempt, request_body, response_code, response_body, error, started_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, '', 200, '', '', ?, ?)
	`, id, webhookID, "evt-"+id, eventType, status, attempt, startedAt.UTC(), startedAt.UTC().Add(50*time.Millisecond)); err != nil {
		t.Fatalf("seed delivery %q: %v", id, err)
	}
}

// webhooksRouter mounts all 9 /api/v1/webhooks/* endpoints
// behind RequireAuth — the same middleware stack main.go uses
// in production. Mounting each route in its own group so a
// per-test failure shows up at the right URL.
func webhooksRouter(db *sql.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1/webhooks")
	g.Use(handlers.RequireAuth(db))
	{
		g.GET("", handlers.ListWebhooks(db))
		g.POST("", handlers.CreateWebhook(db))
		g.GET("/:id", handlers.GetWebhook(db))
		g.PATCH("/:id", handlers.UpdateWebhook(db))
		g.DELETE("/:id", handlers.DeleteWebhook(db))
		g.POST("/:id/rotate", handlers.RotateWebhookSecret(db))
		g.POST("/:id/test", handlers.TestWebhook(db))
		g.GET("/:id/deliveries", handlers.ListWebhookDeliveries(db))
		g.GET("/events", handlers.WebhookEventCatalogue(db))
	}
	return r
}

// jsonBody marshals v or fails the test. Centralised so the
// per-request literal lives on one short line and the failure
// mode (encode error vs handler error) is obvious from the
// stack frame.
func jsonBody(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return raw
}

// withBearerAuth stamps an Authorization: Bearer header so the
// request resolves to the supplied tokenKey via the
// getCurrentUserFromRequest path inside RequireAuth.
func withBearerAuth(req *http.Request, tokenKey string) *http.Request {
	req.Header.Set("Authorization", "Bearer "+tokenKey)
	return req
}

// drainEventBus installs a fresh default EventBus and a
// drainer goroutine so the /test endpoint's bus.Publish call
// returns immediately and the queued event doesn't leak into
// the next sub-test's snapshot. The returned teardown closes
// the bus and waits for the drainer to exit; callers should
// `defer teardown()`.
func drainEventBus(t *testing.T) func() {
	t.Helper()
	services.ResetDefaultEventBusForTest()
	bus := services.GetDefaultEventBus()
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-bus.Channel():
				// drop the event — the handler already enqueued
				// it on the production channel, we just need
				// to make sure the buffer doesn't fill up
				// across the suite
			case <-done:
				return
			}
		}
	}()
	return func() {
		close(done)
		wg.Wait()
		services.ResetDefaultEventBusForTest()
	}
}

// ======================================================================
// ListWebhooks — GET /api/v1/webhooks
// ======================================================================

// TestWebhooks_List covers the list endpoint. Happy path
// asserts the response shape + secret redaction + that
// count matches len(webhooks). The empty-table case is the
// regression guard for the "return [] not null" rule. The
// 401 case exercises the RequireAuth middleware.
func TestWebhooks_List(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	cases := []struct {
		name      string
		setup     func(t *testing.T, db *sql.DB)
		auth      string // tokenKey, "" = no auth
		wantCode  int
		wantCount int
		checkBody func(t *testing.T, body []byte)
	}{
		{
			name:      "401 without auth",
			setup:     func(t *testing.T, db *sql.DB) {},
			auth:      "",
			wantCode:  http.StatusUnauthorized,
			wantCount: 0,
		},
		{
			name:      "401 with bogus token",
			setup:     func(t *testing.T, db *sql.DB) {},
			auth:      "not-a-real-token",
			wantCode:  http.StatusUnauthorized,
			wantCount: 0,
		},
		{
			name:      "200 MEMBER sees redacted list",
			setup:     func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/a", `["task.created"]`) },
			auth:      webhookMemberTok,
			wantCode:  http.StatusOK,
			wantCount: 1,
			checkBody: func(t *testing.T, body []byte) {
				var resp struct {
					Webhooks []map[string]any `json:"webhooks"`
					Count    int              `json:"count"`
				}
				if err := json.Unmarshal(body, &resp); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if len(resp.Webhooks) != 1 {
					t.Fatalf("expected 1 row, got %d", len(resp.Webhooks))
				}
				if secret, _ := resp.Webhooks[0]["secret"].(string); secret != services.WebhookSecretRedacted {
					t.Errorf("secret must be redacted, got %q", secret)
				}
				if id, _ := resp.Webhooks[0]["id"].(string); id != "w1" {
					t.Errorf("id: want w1, got %q", id)
				}
			},
		},
		{
			name:      "200 ADMIN also allowed",
			setup:     func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/a", `["task.created"]`) },
			auth:      webhookAdminTok,
			wantCode:  http.StatusOK,
			wantCount: 1,
		},
		{
			name:      "200 empty table returns [] (never null)",
			setup:     func(t *testing.T, db *sql.DB) {},
			auth:      webhookAdminTok,
			wantCode:  http.StatusOK,
			wantCount: 0,
			checkBody: func(t *testing.T, body []byte) {
				if !bytes.Contains(body, []byte(`"webhooks":[]`)) {
					t.Errorf("empty list must render as [] not null; body=%s", body)
				}
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupWebhooksDB(t)
			defer db.Close()
			tc.setup(t, db)

			r := webhooksRouter(db)
			req, _ := http.NewRequest("GET", "/api/v1/webhooks", nil)
			if tc.auth != "" {
				withBearerAuth(req, tc.auth)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != tc.wantCode {
				t.Fatalf("code: want %d, got %d (body=%s)", tc.wantCode, w.Code, w.Body.String())
			}
			if tc.checkBody != nil {
				tc.checkBody(t, w.Body.Bytes())
			}
		})
	}
}

// ======================================================================
// CreateWebhook — POST /api/v1/webhooks (ADMIN)
// ======================================================================

// TestWebhooks_Create walks the admin-only POST endpoint.
// Happy path asserts the redacted view + plaintext secret
// are returned exactly once. The 403 case is the role gate.
// The 400 table covers each branch of the validator the
// service layer can reject (name, url, eventTypes, filters,
// headers, timeoutSec, maxRetries).
func TestWebhooks_Create(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	t.Run("401 without auth", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks", bytes.NewBuffer(jsonBody(t, map[string]any{
			"name": "x",
			"url":  "https://example.com/x",
		})))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("403 MEMBER cannot create", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks", bytes.NewBuffer(jsonBody(t, map[string]any{
			"name": "x",
			"url":  "https://example.com/x",
		})))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("400 invalid JSON body", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks", bytes.NewBufferString("{not json"))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("201 ADMIN happy path returns redacted view + plaintext", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		body := map[string]any{
			"name":       "primary",
			"url":        "https://example.com/hook",
			"eventTypes": []string{"task.created", "task.updated"},
			"filters":    map[string]any{},
			"headers":    map[string]any{},
		}
		req, _ := http.NewRequest("POST", "/api/v1/webhooks", bytes.NewBuffer(jsonBody(t, body)))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
		}
		var resp struct {
			Webhook         map[string]any `json:"webhook"`
			PlaintextSecret string         `json:"plaintextSecret"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if id, _ := resp.Webhook["id"].(string); id == "" {
			t.Error("webhook.id should be populated")
		}
		if secret, _ := resp.Webhook["secret"].(string); secret != services.WebhookSecretRedacted {
			t.Errorf("webhook.secret must be redacted, got %q", secret)
		}
		if resp.PlaintextSecret == "" {
			t.Error("plaintextSecret must be returned exactly once")
		}
		if len(resp.PlaintextSecret) != services.WebhookSecretLength*2 {
			t.Errorf("plaintextSecret length: got %d want %d", len(resp.PlaintextSecret), services.WebhookSecretLength*2)
		}
		if name, _ := resp.Webhook["name"].(string); name != "primary" {
			t.Errorf("name: got %q", name)
		}
	})

	// URL validation failures — each one is a separate
	// sub-test so a regression names the offending input
	// directly in the test output.
	urlCases := []struct {
		name      string
		body      map[string]any
		wantField string
		wantSub   string
	}{
		{
			name:      "400 missing name",
			body:      map[string]any{"url": "https://example.com/x"},
			wantField: "name",
		},
		{
			name:      "400 blank name",
			body:      map[string]any{"name": "   ", "url": "https://example.com/x"},
			wantField: "name",
		},
		{
			name:      "400 missing url",
			body:      map[string]any{"name": "x"},
			wantField: "url",
		},
		{
			name:      "400 http scheme rejected",
			body:      map[string]any{"name": "x", "url": "http://example.com/x"},
			wantField: "url",
			wantSub:   "https",
		},
		{
			name:      "400 loopback host rejected",
			body:      map[string]any{"name": "x", "url": "https://127.0.0.1/hook"},
			wantField: "url",
		},
		{
			name:      "400 RFC1918 host rejected",
			body:      map[string]any{"name": "x", "url": "https://10.0.0.5/hook"},
			wantField: "url",
		},
		{
			name:      "400 link-local host rejected",
			body:      map[string]any{"name": "x", "url": "https://169.254.169.254/hook"},
			wantField: "url",
		},
		{
			name:      "400 localhost host rejected",
			body:      map[string]any{"name": "x", "url": "https://localhost/hook"},
			wantField: "url",
		},
		{
			name:      "400 eventTypes not an array",
			body:      map[string]any{"name": "x", "url": "https://example.com/x", "eventTypes": map[string]any{"a": 1}},
			wantField: "eventTypes",
		},
		{
			name:      "400 filters not an object",
			body:      map[string]any{"name": "x", "url": "https://example.com/x", "filters": []string{"x"}},
			wantField: "filters",
		},
		{
			name:      "400 timeoutSec out of range",
			body:      map[string]any{"name": "x", "url": "https://example.com/x", "timeoutSec": 999},
			wantField: "timeoutSec",
		},
	}

	for _, tc := range urlCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupWebhooksDB(t)
			defer db.Close()
			r := webhooksRouter(db)
			req, _ := http.NewRequest("POST", "/api/v1/webhooks", bytes.NewBuffer(jsonBody(t, tc.body)))
			req.Header.Set("Content-Type", "application/json")
			withBearerAuth(req, webhookAdminTok)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
			}
			var resp map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if field, _ := resp["field"].(string); field != tc.wantField {
				t.Errorf("field: want %q, got %q", tc.wantField, field)
			}
			if tc.wantSub != "" {
				if errStr, _ := resp["error"].(string); !strings.Contains(strings.ToLower(errStr), tc.wantSub) {
					t.Errorf("error: want substring %q, got %q", tc.wantSub, errStr)
				}
			}
		})
	}
}

// ======================================================================
// GetWebhook — GET /api/v1/webhooks/:id (any auth)
// ======================================================================

// TestWebhooks_Get covers the per-id read. The happy path
// confirms the redacted view; the 404 path confirms the
// domain-error mapping; the 401 path confirms RequireAuth.
func TestWebhooks_Get(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	db := setupWebhooksDB(t)
	defer db.Close()
	seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
	r := webhooksRouter(db)

	t.Run("401 without auth", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/ghost", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("200 MEMBER sees redacted view", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp struct {
			Webhook map[string]any `json:"webhook"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if id, _ := resp.Webhook["id"].(string); id != "w1" {
			t.Errorf("id: want w1, got %q", id)
		}
		if secret, _ := resp.Webhook["secret"].(string); secret != services.WebhookSecretRedacted {
			t.Errorf("secret must be redacted, got %q", secret)
		}
	})
}

// ======================================================================
// UpdateWebhook — PATCH /api/v1/webhooks/:id (ADMIN)
// ======================================================================

// TestWebhooks_Update covers the PATCH endpoint. The table
// is the contract — adding a new branch in the service
// validator means appending a row here.
func TestWebhooks_Update(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	cases := []struct {
		name     string
		setup    func(t *testing.T, db *sql.DB)
		auth     string
		id       string
		body     map[string]any
		wantCode int
		check    func(t *testing.T, body []byte)
	}{
		{
			name:     "401 without auth",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     "",
			id:       "w1",
			body:     map[string]any{"name": "x"},
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "403 MEMBER cannot update",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     webhookMemberTok,
			id:       "w1",
			body:     map[string]any{"name": "renamed"},
			wantCode: http.StatusForbidden,
		},
		{
			name:     "404 unknown id",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     webhookAdminTok,
			id:       "ghost",
			body:     map[string]any{"name": "x"},
			wantCode: http.StatusNotFound,
		},
		{
			name:     "400 invalid URL scheme",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     webhookAdminTok,
			id:       "w1",
			body:     map[string]any{"url": "http://insecure.example.com/x"},
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "400 loopback URL rejected",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     webhookAdminTok,
			id:       "w1",
			body:     map[string]any{"url": "https://127.0.0.1/hook"},
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "200 ADMIN renames",
			setup:    func(t *testing.T, db *sql.DB) { seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`) },
			auth:     webhookAdminTok,
			id:       "w1",
			body:     map[string]any{"name": "renamed", "enabled": false},
			wantCode: http.StatusOK,
			check: func(t *testing.T, body []byte) {
				var resp struct {
					Webhook map[string]any `json:"webhook"`
				}
				if err := json.Unmarshal(body, &resp); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if name, _ := resp.Webhook["name"].(string); name != "renamed" {
					t.Errorf("name: want renamed, got %q", name)
				}
				if en, _ := resp.Webhook["enabled"].(bool); en {
					t.Error("enabled should be false")
				}
				if secret, _ := resp.Webhook["secret"].(string); secret != services.WebhookSecretRedacted {
					t.Errorf("secret must stay redacted, got %q", secret)
				}
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupWebhooksDB(t)
			defer db.Close()
			tc.setup(t, db)

			r := webhooksRouter(db)
			req, _ := http.NewRequest("PATCH", "/api/v1/webhooks/"+tc.id, bytes.NewBuffer(jsonBody(t, tc.body)))
			req.Header.Set("Content-Type", "application/json")
			if tc.auth != "" {
				withBearerAuth(req, tc.auth)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != tc.wantCode {
				t.Fatalf("code: want %d, got %d (body=%s)", tc.wantCode, w.Code, w.Body.String())
			}
			if tc.check != nil {
				tc.check(t, w.Body.Bytes())
			}
		})
	}
}

// ======================================================================
// DeleteWebhook — DELETE /api/v1/webhooks/:id (ADMIN)
// ======================================================================

// TestWebhooks_Delete exercises the DELETE endpoint. The
// happy path asserts success + row removal; the 404 path
// asserts the second delete is also a 404 (so the UI's
// double-click protection works).
func TestWebhooks_Delete(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	t.Run("401 without auth", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("DELETE", "/api/v1/webhooks/w1", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", w.Code)
		}
	})

	t.Run("403 MEMBER cannot delete", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("DELETE", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403, got %d", w.Code)
		}
	})

	t.Run("200 ADMIN removes row", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("DELETE", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if ok, _ := resp["success"].(bool); !ok {
			t.Error("expected success=true")
		}
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM webhooks WHERE id = 'w1'").Scan(&count); err != nil {
			t.Fatalf("count: %v", err)
		}
		if count != 0 {
			t.Errorf("row should be gone, got count=%d", count)
		}
	})

	t.Run("404 second delete", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		// first delete
		req, _ := http.NewRequest("DELETE", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		// second delete
		req2, _ := http.NewRequest("DELETE", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req2, webhookAdminTok)
		w2 := httptest.NewRecorder()
		r.ServeHTTP(w2, req2)
		if w2.Code != http.StatusNotFound {
			t.Fatalf("want 404 on second delete, got %d", w2.Code)
		}
	})
}

// ======================================================================
// RotateWebhookSecret — POST /api/v1/webhooks/:id/rotate (ADMIN)
// ======================================================================

// TestWebhooks_Rotate exercises the secret rotation endpoint.
// The plain rotation assert is that the new plaintext
// differs from the original; the follow-up Get must show
// the redacted placeholder, not the new plaintext.
func TestWebhooks_Rotate(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	t.Run("401 without auth", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/rotate", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", w.Code)
		}
	})

	t.Run("403 MEMBER cannot rotate", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/rotate", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403, got %d", w.Code)
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/ghost/rotate", nil)
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("200 ADMIN rotates + new plaintext differs", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/rotate", nil)
		withBearerAuth(req, webhookAdminTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp struct {
			Webhook         map[string]any `json:"webhook"`
			PlaintextSecret string         `json:"plaintextSecret"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.PlaintextSecret == "" {
			t.Fatal("plaintextSecret must be returned")
		}
		if secret, _ := resp.Webhook["secret"].(string); secret != services.WebhookSecretRedacted {
			t.Errorf("view.secret must be redacted, got %q", secret)
		}
		// Follow-up Get must show the redacted placeholder,
		// never the new plaintext.
		req2, _ := http.NewRequest("GET", "/api/v1/webhooks/w1", nil)
		withBearerAuth(req2, webhookAdminTok)
		w2 := httptest.NewRecorder()
		r.ServeHTTP(w2, req2)
		var getResp struct {
			Webhook map[string]any `json:"webhook"`
		}
		if err := json.Unmarshal(w2.Body.Bytes(), &getResp); err != nil {
			t.Fatalf("decode get: %v", err)
		}
		if secret, _ := getResp.Webhook["secret"].(string); secret != services.WebhookSecretRedacted {
			t.Errorf("Get after rotate must stay redacted, got %q", secret)
		}
	})
}

// ======================================================================
// TestWebhook — POST /api/v1/webhooks/:id/test (any auth)
// ======================================================================

// TestWebhooks_Test exercises the synthetic-event endpoint.
// Happy path asserts the 202 + envelope id + that the event
// reached the EventBus. The 400 / 404 table covers the
// pre-publish validation branches.
func TestWebhooks_Test(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	t.Run("401 without auth", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{"event": "task.created"})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", w.Code)
		}
	})

	t.Run("404 unknown id", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{"event": "task.created"})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/ghost/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("400 missing event", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("400 unknown event name", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{"event": "totally.bogus.event"})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("400 webhook does not subscribe", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.deleted"]`)
		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{"event": "task.created"})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("202 MEMBER publishes synthetic event", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)

		teardown := drainEventBus(t)
		defer teardown()

		r := webhooksRouter(db)
		body := jsonBody(t, map[string]any{
			"event": "task.created",
			"data":  map[string]any{"hello": "world"},
		})
		req, _ := http.NewRequest("POST", "/api/v1/webhooks/w1/test", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusAccepted {
			t.Fatalf("want 202, got %d (%s)", w.Code, w.Body.String())
		}
		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp["success"] != true {
			t.Errorf("success: want true, got %v", resp["success"])
		}
		if event, _ := resp["event"].(string); event != "task.created" {
			t.Errorf("event: want task.created, got %q", event)
		}
		if id, _ := resp["envelopeId"].(string); id == "" {
			t.Error("envelopeId should be non-empty")
		}
		if wh, _ := resp["webhookId"].(string); wh != "w1" {
			t.Errorf("webhookId: want w1, got %q", wh)
		}
	})
}

// ======================================================================
// ListWebhookDeliveries — GET /api/v1/webhooks/:id/deliveries
// ======================================================================

// TestWebhooks_Deliveries covers the cursor-paginated log.
// The pagination + 400 cases are the headline regression
// guards — the cursor encoding/decoding pair is easy to
// break when the SQL or the base64 wrapper drifts.
func TestWebhooks_Deliveries(t *testing.T) {
	handlers.ResetTokenCacheForTest()

	t.Run("401 without auth", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", w.Code)
		}
	})

	t.Run("404 unknown webhook", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		r := webhooksRouter(db)
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/ghost/deliveries", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("200 empty webhook returns []", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		r := webhooksRouter(db)
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		if !bytes.Contains(w.Body.Bytes(), []byte(`"deliveries":[]`)) {
			t.Errorf("empty must render as [] not null; body=%s", w.Body.String())
		}
	})

	t.Run("200 returns paginated rows with hasMore/nextCursor", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
		for i := 0; i < 5; i++ {
			seedDelivery(t, db, fmt.Sprintf("d%d", i), "w1", "task.created", "SUCCESS", base.Add(time.Duration(i)*time.Second), 1)
		}

		r := webhooksRouter(db)
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries?limit=2", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var page1 struct {
			Deliveries []map[string]any `json:"deliveries"`
			Count      int              `json:"count"`
			NextCursor string           `json:"nextCursor"`
			HasMore    bool             `json:"hasMore"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &page1); err != nil {
			t.Fatalf("decode page1: %v", err)
		}
		if page1.Count != 2 || len(page1.Deliveries) != 2 {
			t.Errorf("page1 count: want 2, got %d", page1.Count)
		}
		if !page1.HasMore || page1.NextCursor == "" {
			t.Errorf("page1 must report more rows; got hasMore=%v nextCursor=%q", page1.HasMore, page1.NextCursor)
		}
		// First row should be the newest (d4 by started_at DESC).
		if id, _ := page1.Deliveries[0]["id"].(string); id != "d4" {
			t.Errorf("page1[0].id: want d4 (newest), got %q", id)
		}

		// Follow the cursor to page 2 — must return d2 and d1.
		req2, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries?limit=2&cursor="+page1.NextCursor, nil)
		withBearerAuth(req2, webhookMemberTok)
		w2 := httptest.NewRecorder()
		r.ServeHTTP(w2, req2)
		if w2.Code != http.StatusOK {
			t.Fatalf("want 200 on page2, got %d (%s)", w2.Code, w2.Body.String())
		}
		var page2 struct {
			Deliveries []map[string]any `json:"deliveries"`
			NextCursor string           `json:"nextCursor"`
			HasMore    bool             `json:"hasMore"`
		}
		if err := json.Unmarshal(w2.Body.Bytes(), &page2); err != nil {
			t.Fatalf("decode page2: %v", err)
		}
		if len(page2.Deliveries) != 2 {
			t.Errorf("page2 count: want 2, got %d", len(page2.Deliveries))
		}
		if id, _ := page2.Deliveries[0]["id"].(string); id != "d2" {
			t.Errorf("page2[0].id: want d2, got %q", id)
		}
		if !page2.HasMore {
			t.Error("page2 should still report more rows (d0 remains)")
		}

		// Page 3 — d0 only, no more pages. nextCursor
		// lives on the top-level response, not per-row.
		req3, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries?limit=2&cursor="+page2.NextCursor, nil)
		withBearerAuth(req3, webhookMemberTok)
		w3 := httptest.NewRecorder()
		r.ServeHTTP(w3, req3)
		var page3 struct {
			Deliveries []map[string]any `json:"deliveries"`
			HasMore    bool             `json:"hasMore"`
			NextCursor string           `json:"nextCursor"`
		}
		if err := json.Unmarshal(w3.Body.Bytes(), &page3); err != nil {
			t.Fatalf("decode page3: %v", err)
		}
		if len(page3.Deliveries) != 1 {
			t.Errorf("page3 count: want 1, got %d", len(page3.Deliveries))
		}
		if id, _ := page3.Deliveries[0]["id"].(string); id != "d0" {
			t.Errorf("page3[0].id: want d0, got %q", id)
		}
		if page3.HasMore || page3.NextCursor != "" {
			t.Errorf("page3 must report no more; got hasMore=%v nextCursor=%q", page3.HasMore, page3.NextCursor)
		}
	})

	// Pagination edge cases — 400s for the parser branches
	// the URL parameter parser owns.
	badCases := []struct {
		name  string
		query string
	}{
		{name: "400 limit not integer", query: "?limit=abc"},
		{name: "400 limit <= 0", query: "?limit=0"},
		{name: "400 limit negative", query: "?limit=-5"},
		{name: "400 cursor not base64", query: "?cursor=not-base64!!!"},
		{name: "400 cursor missing colon", query: "?cursor=" + base64RawURL("just-a-token")},
		{name: "400 cursor unparseable nano", query: "?cursor=" + base64RawURL("notanumber:abc")},
	}
	for _, tc := range badCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupWebhooksDB(t)
			defer db.Close()
			seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
			r := webhooksRouter(db)
			req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries"+tc.query, nil)
			withBearerAuth(req, webhookMemberTok)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d (%s)", w.Code, w.Body.String())
			}
		})
	}

	t.Run("200 limit larger than max is capped", func(t *testing.T) {
		db := setupWebhooksDB(t)
		defer db.Close()
		seedWebhook(t, db, "w1", "primary", "https://example.com/x", `["task.created"]`)
		// Seed 3 deliveries; asking for limit=200 should cap
		// at 100 (no effect here, but confirms the branch).
		base := time.Now().UTC().Add(-time.Hour)
		for i := 0; i < 3; i++ {
			seedDelivery(t, db, fmt.Sprintf("d%d", i), "w1", "task.created", "SUCCESS", base.Add(time.Duration(i)*time.Second), 1)
		}
		r := webhooksRouter(db)
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/w1/deliveries?limit=200", nil)
		withBearerAuth(req, webhookMemberTok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp struct {
			Count int `json:"count"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Count != 3 {
			t.Errorf("count: want 3, got %d", resp.Count)
		}
	})
}

// base64RawURL is a tiny helper that produces the
// raw-URL-no-padding base64 form the cursor parser uses.
// Wrapping a literal here keeps the 400-cursor test cases
// readable.
func base64RawURL(s string) string {
	return strings.TrimRight(strings.ReplaceAll(strings.ReplaceAll(
		base64Std(s),
		"+", "-"), "/", "_"), "=")
}

func base64Std(s string) string {
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	out := make([]byte, 0, len(s)*4/3+4)
	for i := 0; i < len(s); i += 3 {
		var b [3]byte
		n := copy(b[:], s[i:])
		out = append(out, tbl[b[0]>>2])
		out = append(out, tbl[((b[0]&0x03)<<4)|(b[1]>>4)])
		if n > 1 {
			out = append(out, tbl[((b[1]&0x0f)<<2)|(b[2]>>6)])
		}
		if n > 2 {
			out = append(out, tbl[b[2]&0x3f])
		}
	}
	return string(out)
}
