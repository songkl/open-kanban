package oauth_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/handlers"
	"open-kanban/internal/oauth"
)

func setupApproveDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupTokenDB(t)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS oauth_consents (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(user_id, client_id)
	)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func insertPendingDevice(t *testing.T, db *sql.DB, clientID, userCode, scope string, ttl time.Duration) {
	t.Helper()
	hash := oauth.HashToken(userCode)
	_, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, interval_seconds, status, verification_uri, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 5, 'pending', 'http://x', ?)`,
		"dc-"+userCode, hash, hash, userCode, clientID, scope, time.Now().Add(ttl), time.Now(),
	)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func newApproveServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.POST("/oauth/device/approve", handlers.RequireAuth(db), oauth.DeviceApproveHandler(db))
	r.GET("/oauth/device/lookup", oauth.DeviceLookupHandler(db))
	return r
}

func TestApproveDeviceSucceeds(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-client-1", "ABCD-EFGH", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"ABCD-EFGH","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["approved"] != true {
		t.Errorf("expected approved=true, got %v", resp)
	}
	if resp["clientId"] != "kanban-client-1" {
		t.Errorf("expected clientId kanban-client-1, got %v", resp)
	}

	var status string
	if err := db.QueryRow(`SELECT status FROM oauth_device_codes WHERE user_code_display = 'ABCD-EFGH'`).Scan(&status); err != nil {
		t.Fatalf("query: %v", err)
	}
	if status != "approved" {
		t.Errorf("expected status approved, got %s", status)
	}

	// Consent should be recorded
	var consentScope string
	if err := db.QueryRow(`SELECT scope FROM oauth_consents WHERE user_id = 'user-1' AND client_id = 'kanban-client-1'`).Scan(&consentScope); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if consentScope != "kanban:read" {
		t.Errorf("expected scope kanban:read, got %s", consentScope)
	}
}

func TestDenyDeviceSucceeds(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-client-1", "WXYZ-1234", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"WXYZ-1234","decision":"deny"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var status string
	_ = db.QueryRow(`SELECT status FROM oauth_device_codes WHERE user_code_display = 'WXYZ-1234'`).Scan(&status)
	if status != "denied" {
		t.Errorf("expected status denied, got %s", status)
	}
}

func TestApproveDeviceRequiresAuth(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	r := newApproveServer(t, db)

	body := `{"user_code":"ABCD-EFGH","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestApproveDeviceUnknownUserCode(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	r := newApproveServer(t, db)

	body := `{"user_code":"ZZZZ-ZZZZ","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestApproveDeviceExpiredReturns410(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-client-1", "EXPR-EXPR", "kanban:read", -time.Minute)
	r := newApproveServer(t, db)

	body := `{"user_code":"EXPR-EXPR","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d", w.Code)
	}
}

func TestApproveDeviceNormalisesLowercaseUserCode(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-client-1", "CASE-CASE", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	// lower-case submission should still match
	body := `{"user_code":"case-case","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestApproveDeviceInvalidDecision(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	r := newApproveServer(t, db)

	body := `{"user_code":"ABCD-EFGH","decision":"maybe"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "user-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeviceLookupReturnsClientMetadata(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-client-1", "LOOK-UP99", "kanban:read tasks:write", time.Hour)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=look-up99", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["clientId"] != "kanban-client-1" {
		t.Errorf("clientId mismatch: %v", resp)
	}
	if resp["clientName"] != "open-kanban-mcp" {
		t.Errorf("clientName mismatch: %v", resp)
	}
	if resp["scope"] != "kanban:read tasks:write" {
		t.Errorf("scope mismatch: %v", resp)
	}
}

func TestDeviceLookupRejectsUnknownCode(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=GHOST", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestDeviceLookupRequiresUserCode(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// setApproveUser seeds a token for the given user and attaches it as a
// cookie so the embedded auth middleware can pick it up. This is a test-only
// helper that avoids constructing a full gin auth middleware.
func setApproveUser(req *http.Request, db *sql.DB, userID string) {
	if _, err := db.Exec(`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled) VALUES (?, ?, ?, '', 'HUMAN', 'ADMIN', 1)`,
		userID, userID, userID); err != nil {
		panic(err)
	}
	key := "test-token-" + userID
	if _, err := db.Exec(`INSERT OR IGNORE INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		"tok-"+userID, "test", key, userID, time.Now(), time.Now()); err != nil {
		panic(err)
	}
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: key})
}
