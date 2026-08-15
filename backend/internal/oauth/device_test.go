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
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/oauth"
)

func setupDeviceDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupRegisterDB(t)
	schema := `
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
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func seedClient(t *testing.T, db *sql.DB, id, secretHash, name string, grantTypes []string, scopes []string) string {
	t.Helper()
	if secretHash != "" {
		hash := mustHashSecret(t, secretHash)
		_, err := db.Exec(`UPDATE oauth_clients SET client_secret_hash = ? WHERE client_id = ?`, hash, id)
		if err != nil {
			// row may not exist yet, insert below
			insertClient(t, db, id, hash, name, grantTypes, scopes)
			return id
		}
	}
	insertClient(t, db, id, secretHash, name, grantTypes, scopes)
	return id
}

func insertClient(t *testing.T, db *sql.DB, id, secretHash, name string, grantTypes []string, scopes []string) {
	t.Helper()
	gj, _ := json.Marshal(grantTypes)
	sj, _ := json.Marshal(scopes)
	method := "none"
	var secretParam interface{}
	if secretHash != "" {
		method = "client_secret_basic"
		secretParam = secretHash
	}
	_, err := db.Exec(
		`INSERT INTO oauth_clients
			(id, client_id, client_secret_hash, name, redirect_uris, grant_types,
			 token_endpoint_auth_method, scopes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
		"row-"+id, id, secretParam, name, string(gj), method, string(sj), time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatalf("insert client: %v", err)
	}
}

func mustHashSecret(t *testing.T, plain string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	return string(hash)
}

func bcryptHash(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(hash), err
}

func newDeviceServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.POST("/oauth/device/code", oauth.RequestDeviceCode(db))
	return r
}

func TestRequestDeviceCodeSuccess(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		[]string{"kanban:read", "tasks:write"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-client-1&scope=kanban:read+tasks:write"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["device_code"] == nil || resp["device_code"].(string) == "" {
		t.Error("expected non-empty device_code")
	}
	if resp["user_code"] == nil {
		t.Error("expected user_code")
	}
	uc := resp["user_code"].(string)
	if !strings.Contains(uc, "-") || len(uc) != 9 {
		t.Errorf("expected user_code shape XXXX-XXXX, got %q", uc)
	}
	if v, _ := resp["verification_uri"].(string); v != "http://kanban.example/oauth/device" {
		t.Errorf("verification_uri mismatch: %s", v)
	}
	if v, _ := resp["verification_uri_complete"].(string); v != "http://kanban.example/oauth/device?user_code="+uc {
		t.Errorf("verification_uri_complete mismatch: %s", v)
	}
	if exp, ok := resp["expires_in"].(float64); !ok || exp <= 0 {
		t.Errorf("expected positive expires_in, got %v", resp["expires_in"])
	}
	if interval, ok := resp["interval"].(float64); !ok || interval < 1 {
		t.Errorf("expected interval >= 1, got %v", resp["interval"])
	}

	// Device row persisted with status pending and matching hash.
	var (
		hash    string
		display string
		status  string
	)
	if err := db.QueryRow(
		`SELECT device_code_hash, user_code_display, status FROM oauth_device_codes WHERE user_code_display = ?`,
		uc,
	).Scan(&hash, &display, &status); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if display != uc {
		t.Errorf("expected display %q, got %q", uc, display)
	}
	if status != "pending" {
		t.Errorf("expected status pending, got %s", status)
	}
	if hash == resp["device_code"] {
		t.Error("device_code stored must be hashed, not plaintext")
	}
}

func TestRequestDeviceCodeAcceptsJSONBody(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := `{"client_id":"kanban-client-1","scope":"kanban:read"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestRequestDeviceCodeMissingClientIDReturns400(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	r := newDeviceServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader("scope=kanban:read"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_request" {
		t.Errorf("expected invalid_request, got %v", resp)
	}
}

func TestRequestDeviceCodeUnknownClientReturns400(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	r := newDeviceServer(t, db)

	body := "client_id=ghost"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_client" {
		t.Errorf("expected invalid_client, got %v", resp)
	}
}

func TestRequestDeviceCodeClientWithoutDeviceGrantReturns400(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-2", "", "auth-only",
		[]string{"authorization_code", "refresh_token"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-client-2"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "unauthorized_client" {
		t.Errorf("expected unauthorized_client, got %v", resp)
	}
}

func TestRequestDeviceCodeRejectsScopeNotInRegistration(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-client-1&scope=boards:admin"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRequestDeviceCodeHonoursConfiguredTTLs(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('oauth_device_code_ttl_seconds', '60'), ('oauth_device_poll_interval_seconds', '3')`); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	r := newDeviceServer(t, db)

	body := "client_id=kanban-client-1"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if exp, _ := resp["expires_in"].(float64); int(exp) != 60 {
		t.Errorf("expected expires_in 60, got %v", resp["expires_in"])
	}
	if interval, _ := resp["interval"].(float64); int(interval) != 3 {
		t.Errorf("expected interval 3, got %v", resp["interval"])
	}
}

func TestGenerateUserCodeFormat(t *testing.T) {
	for i := 0; i < 50; i++ {
		code, err := oauth.GenerateUserCodeForTest()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(code) != 9 {
			t.Fatalf("expected 9 chars, got %d (%q)", len(code), code)
		}
		if code[4] != '-' {
			t.Errorf("expected dash at pos 4, got %q", code[4:])
		}
		for j, ch := range code {
			if j == 4 {
				continue
			}
			if strings.ContainsRune("0O1I", ch) {
				t.Errorf("confusable char in user_code: %q at %d", code, j)
			}
		}
	}
}

func TestApproveDeviceCodeFlow(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-client-1"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("device code request failed: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	uc := resp["user_code"].(string)
	dc, err := oauth.ApproveDeviceCode(db, uc, "user-1")
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if dc.Status != "approved" {
		t.Errorf("expected approved, got %s", dc.Status)
	}
	if dc.UserID == nil || *dc.UserID != "user-1" {
		t.Errorf("expected user-1, got %v", dc.UserID)
	}
}

func TestApproveDeviceCodeExpiredReturnsError(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})

	// Insert a row directly with a past expiry.
	uc := "ABCD-EFGH"
	hash := oauth.HashToken(uc)
	_, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, status, verification_uri, created_at)
		 VALUES ('dc-1', 'h', ?, ?, 'kanban-client-1', 'kanban:read', ?, 'pending', 'http://x', ?)`,
		hash, uc, time.Now().Add(-time.Minute), time.Now(),
	)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := oauth.ApproveDeviceCode(db, uc, "user-1"); err == nil {
		t.Error("expected error for expired device code")
	}
	// status should now be expired
	var status string
	_ = db.QueryRow("SELECT status FROM oauth_device_codes WHERE id = 'dc-1'").Scan(&status)
	if status != "expired" {
		t.Errorf("expected expired status, got %s", status)
	}
}

func TestDenyDeviceCode(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})

	uc := "WXYZ-1234"
	hash := oauth.HashToken(uc)
	_, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, status, verification_uri, created_at)
		 VALUES ('dc-1', 'h', ?, ?, 'kanban-client-1', 'kanban:read', ?, 'pending', 'http://x', ?)`,
		hash, uc, time.Now().Add(time.Hour), time.Now(),
	)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := oauth.DenyDeviceCode(db, uc, "user-1"); err != nil {
		t.Fatalf("deny: %v", err)
	}
	var status string
	_ = db.QueryRow("SELECT status FROM oauth_device_codes WHERE id = 'dc-1'").Scan(&status)
	if status != "denied" {
		t.Errorf("expected denied, got %s", status)
	}

	// Second denial should fail
	if err := oauth.DenyDeviceCode(db, uc, "user-1"); err == nil {
		t.Error("expected second denial to fail")
	}
}