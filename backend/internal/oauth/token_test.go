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

func setupTokenDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupDeviceDB(t)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
			id TEXT PRIMARY KEY,
			token_hash TEXT UNIQUE NOT NULL,
			client_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			scope TEXT NOT NULL,
			expires_at DATETIME NOT NULL,
			revoked_at DATETIME,
			replaced_by_id TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			nickname TEXT NOT NULL,
			password TEXT,
			type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN','AGENT')),
			role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN','MEMBER','VIEWER')),
			enabled BOOLEAN DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func seedApprovedDeviceCode(t *testing.T, db *sql.DB, clientID, userID, scope, rawDeviceCode string) string {
	t.Helper()
	hash := oauth.HashToken(rawDeviceCode)
	rowID := "dc-" + clientID
	_, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, interval_seconds, status, user_id, verification_uri, created_at)
		 VALUES (?, ?, 'h', 'USER-CODE', ?, ?, ?, 5, 'approved', ?, 'http://x', ?)`,
		rowID, hash, clientID, scope, time.Now().Add(time.Hour), userID, time.Now(),
	)
	if err != nil {
		t.Fatalf("seed device: %v", err)
	}
	return rowID
}

func newTokenServer(t *testing.T, db *sql.DB) (*gin.Engine, *oauth.Signer) {
	t.Helper()
	signer, _ := seedSigner(t)
	t.Cleanup(func() {})
	r := gin.New()
	r.POST("/oauth/token", oauth.TokenEndpoint(db, signer))
	return r, signer
}

func TestDeviceCodeGrantSuccess(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		[]string{"kanban:read", "tasks:write"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'alice', 'Alice')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	seedApprovedDeviceCode(t, db, "kanban-client-1", "user-1", "kanban:read tasks:write", "device-secret")
	signer := mustSigner(t, db)
	r := gin.New()
	r.POST("/oauth/token", oauth.TokenEndpoint(db, signer))

	form := "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=kanban-client-1&device_code=device-secret"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["access_token"] == nil {
		t.Fatal("expected access_token")
	}
	if resp["token_type"] != "Bearer" {
		t.Errorf("expected Bearer, got %v", resp["token_type"])
	}
	if resp["refresh_token"] == nil {
		t.Error("expected refresh_token")
	}
	if resp["scope"] != "kanban:read tasks:write" {
		t.Errorf("scope mismatch: %v", resp["scope"])
	}

	access := resp["access_token"].(string)
	r2 := gin.New()
	r2.GET("/protected", oauth.RequireBearerToken(signer, oauth.ScopeKanbanRead),
		func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	req2 := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req2.Host = "kanban.example"
	req2.Header.Set("Authorization", "Bearer "+access)
	w2 := httptest.NewRecorder()
	r2.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Errorf("issued access token rejected: %d %s", w2.Code, w2.Body.String())
	}

	hash := oauth.HashToken(resp["refresh_token"].(string))
	var storedHash string
	if err := db.QueryRow("SELECT token_hash FROM oauth_refresh_tokens WHERE token_hash = ?", hash).Scan(&storedHash); err != nil {
		t.Errorf("refresh token row not found: %v", err)
	}
}

func mustSigner(t *testing.T, db *sql.DB) *oauth.Signer {
	t.Helper()
	s := oauth.NewSigner(db)
	if err := s.LoadOrGenerate(); err != nil {
		t.Fatalf("LoadOrGenerate: %v", err)
	}
	return s
}

func TestDeviceCodeGrantPendingReturnsAuthorizationPending(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'alice', 'Alice')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	hash := oauth.HashToken("device-pending")
	_, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, interval_seconds, status, user_id, verification_uri, created_at)
		 VALUES ('dc-1', ?, 'h', 'USER-CODE', 'kanban-client-1', 'kanban:read', ?, 5, 'pending', 'user-1', 'http://x', ?)`,
		hash, time.Now().Add(time.Hour), time.Now(),
	)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	r, _ := newTokenServer(t, db)
	form := "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=kanban-client-1&device_code=device-pending"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "authorization_pending" {
		t.Errorf("expected authorization_pending, got %v", resp)
	}
}

func TestDeviceCodeGrantMismatchedClientReturnsInvalidGrant(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertClient(t, db, "kanban-client-2", "", "other",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'a', 'A')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	seedApprovedDeviceCode(t, db, "kanban-client-1", "user-1", "kanban:read", "device-abc")

	r, _ := newTokenServer(t, db)
	form := "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=kanban-client-2&device_code=device-abc"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_grant" {
		t.Errorf("expected invalid_grant, got %v", resp)
	}
}

func TestRefreshTokenGrantRotatesAndRevokesOld(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		[]string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'a', 'A')`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Seed a refresh token directly
	plain := "rt-original"
	hash := oauth.HashToken(plain)
	if _, err := db.Exec(
		`INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, user_id, scope, expires_at, created_at)
		 VALUES ('rt-1', ?, 'kanban-client-1', 'user-1', 'kanban:read', ?, ?)`,
		hash, time.Now().Add(time.Hour), time.Now(),
	); err != nil {
		t.Fatalf("seed refresh: %v", err)
	}

	r, _ := newTokenServer(t, db)
	form := "grant_type=refresh_token&client_id=kanban-client-1&refresh_token=" + plain
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["access_token"] == nil {
		t.Fatal("expected new access_token")
	}
	if resp["refresh_token"] == nil || resp["refresh_token"].(string) == plain {
		t.Error("expected a new refresh token, not the old one")
	}

	// Old token must be revoked now
	var revoked sql.NullTime
	if err := db.QueryRow("SELECT revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?", hash).Scan(&revoked); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !revoked.Valid {
		t.Error("expected old refresh token to be revoked")
	}
}

func TestRefreshTokenReuseRejected(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"refresh_token"}, []string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'a', 'A')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	plain := "rt-stale"
	hash := oauth.HashToken(plain)
	if _, err := db.Exec(
		`INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, user_id, scope, expires_at, revoked_at, created_at)
		 VALUES ('rt-1', ?, 'kanban-client-1', 'user-1', 'kanban:read', ?, ?, ?)`,
		hash, time.Now().Add(time.Hour), time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	r, _ := newTokenServer(t, db)
	form := "grant_type=refresh_token&client_id=kanban-client-1&refresh_token=" + plain
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_grant" {
		t.Errorf("expected invalid_grant, got %v", resp)
	}
}

func TestClientCredentialsGrantRequiresSecret(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertPublicClient(t, db, "public-client", []string{"client_credentials"})
	r, _ := newTokenServer(t, db)

	form := "grant_type=client_credentials&client_id=public-client"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for public client + client_credentials, got %d: %s", w.Code, w.Body.String())
	}
}

func insertPublicClient(t *testing.T, db *sql.DB, id string, grantTypes []string) {
	t.Helper()
	gj, _ := json.Marshal(grantTypes)
	_, err := db.Exec(
		`INSERT INTO oauth_clients
			(id, client_id, name, redirect_uris, grant_types,
			 token_endpoint_auth_method, scopes, created_at, updated_at)
		 VALUES (?, ?, ?, '[]', ?, 'none', '[]', ?, ?)`,
		"row-"+id, id, id, string(gj), time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatalf("insert public client: %v", err)
	}
}

func TestClientCredentialsGrantSuccessWithSecret(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	hash, err := bcrypt.GenerateFromPassword([]byte("svc-secret"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	insertClient(t, db, "confidential-svc", string(hash), "svc",
		[]string{"client_credentials"}, []string{"kanban:read"})
	r, _ := newTokenServer(t, db)

	form := "grant_type=client_credentials&client_id=confidential-svc&client_secret=svc-secret"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["access_token"] == nil {
		t.Fatal("expected access_token")
	}
	if resp["refresh_token"] != nil && resp["refresh_token"] != "" {
		t.Error("client_credentials should not issue refresh token")
	}
}

func TestClientCredentialsGrantBasicAuth(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	hash, err := bcrypt.GenerateFromPassword([]byte("svc-secret"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	insertClient(t, db, "confidential-svc", string(hash), "svc",
		[]string{"client_credentials"}, []string{"kanban:read"})
	r, _ := newTokenServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader("grant_type=client_credentials"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth("confidential-svc", "svc-secret")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTokenEndpointRejectsUnsupportedGrant(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r, _ := newTokenServer(t, db)

	form := "grant_type=password&client_id=kanban-client-1"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "unsupported_grant_type" {
		t.Errorf("expected unsupported_grant_type, got %v", resp)
	}
}

func TestTokenEndpointSlowDownOnRapidPolling(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('user-1', 'a', 'A')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Insert device code with last_poll_at now and interval=10
	hash := oauth.HashToken("device-poll")
	if _, err := db.Exec(
		`INSERT INTO oauth_device_codes
			(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
			 expires_at, interval_seconds, last_poll_at, status, user_id, verification_uri, created_at)
		 VALUES ('dc-1', ?, 'h', 'USER-CODE', 'kanban-client-1', 'kanban:read', ?, 10, ?, 'pending', 'user-1', 'http://x', ?)`,
		hash, time.Now().Add(time.Hour), time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	r, _ := newTokenServer(t, db)
	form := "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=kanban-client-1&device_code=device-poll"
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if ra := w.Header().Get("Retry-After"); ra == "" {
		t.Error("expected Retry-After header on slow_down")
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "slow_down" {
		t.Errorf("expected slow_down, got %v", resp)
	}
}