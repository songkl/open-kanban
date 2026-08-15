package oauth_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
	"open-kanban/internal/oauth"
)

// AdminUserFixture is a minimal models.User used to inject an authenticated
// user into gin.Context without requiring the full auth middleware.
var AdminUserFixture = &models.User{ID: "user-1", Username: "u1", Nickname: "U1", Enabled: true}

func setupAdminDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupApproveDB(t)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
		id TEXT PRIMARY KEY,
		token_hash TEXT UNIQUE NOT NULL,
		client_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		expires_at DATETIME NOT NULL,
		revoked_at DATETIME,
		replaced_by_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func newAdminServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.GET("/api/v1/auth/oauth/clients", oauth.ListAdminClientsHandler(db))
	r.DELETE("/api/v1/auth/oauth/clients", oauth.DeleteAdminClientHandler(db))
	r.GET("/api/v1/auth/oauth/consents", oauth.ListConsentsHandler(db))
	r.DELETE("/api/v1/auth/oauth/consents", oauth.RevokeConsentHandler(db))
	r.GET("/api/v1/auth/oauth/config", oauth.GetOAuthConfigHandler(db))
	r.PUT("/api/v1/auth/oauth/config", oauth.UpdateOAuthConfigHandler(db))
	return r
}

func TestListAdminClients(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		[]string{"kanban:read"})
	r := newAdminServer(t, db)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/clients", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	list, ok := resp["clients"].([]interface{})
	if !ok {
		t.Fatalf("expected clients array, got %v", resp)
	}
	if len(list) != 1 {
		t.Errorf("expected 1 client, got %d", len(list))
	}
	first := list[0].(map[string]interface{})
	if first["clientId"] != "kanban-client-1" {
		t.Errorf("clientId mismatch: %v", first)
	}
}

func TestDeleteAdminClientRemovesRows(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/clients?client_id=kanban-client-1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM oauth_clients WHERE client_id = 'kanban-client-1'").Scan(&count); err != nil {
		t.Fatalf("query: %v", err)
	}
	if count != 0 {
		t.Errorf("expected client deleted, found %d", count)
	}
}

func TestDeleteAdminClientMissingID(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/clients", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeleteAdminClientNotFound(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/clients?client_id=ghost", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestListConsentsRequiresUser(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/consents", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestListConsentsReturnsRowsForUser(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO oauth_consents (id, user_id, client_id, scope, granted_at) VALUES ('c1', 'user-1', 'kanban-client-1', 'kanban:read', ?)`,
		time.Now()); err != nil {
		t.Fatalf("seed: %v", err)
	}

	r2 := gin.New()
	r2.Use(func(c *gin.Context) {
		c.Set("user", AdminUserFixture)
		c.Next()
	})
	r2.GET("/api/v1/auth/oauth/consents", oauth.ListConsentsHandler(db))
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/consents", nil)
	w2 := httptest.NewRecorder()
	r2.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w2.Code, w2.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w2.Body.Bytes(), &resp)
	list, _ := resp["consents"].([]interface{})
	if len(list) != 1 {
		t.Errorf("expected 1 consent, got %d", len(list))
	}
}

func TestRevokeConsentAlsoRevokesRefreshTokens(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO oauth_consents (id, user_id, client_id, scope, granted_at) VALUES ('c1', 'user-1', 'kanban-client-1', 'kanban:read', ?)`,
		time.Now()); err != nil {
		t.Fatalf("seed consent: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, user_id, scope, expires_at, created_at) VALUES ('rt-1', 'h', 'kanban-client-1', 'user-1', 'kanban:read', ?, ?)`,
		time.Now().Add(time.Hour), time.Now()); err != nil {
		t.Fatalf("seed refresh: %v", err)
	}

	r2 := gin.New()
	r2.Use(func(c *gin.Context) {
		c.Set("user", AdminUserFixture)
		c.Next()
	})
	r2.DELETE("/api/v1/auth/oauth/consents", oauth.RevokeConsentHandler(db))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/consents?client_id=kanban-client-1", nil)
	w := httptest.NewRecorder()
	r2.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var revoked sql.NullTime
	if err := db.QueryRow("SELECT revoked_at FROM oauth_refresh_tokens WHERE id = 'rt-1'").Scan(&revoked); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !revoked.Valid {
		t.Error("expected refresh token to be revoked")
	}
}

func TestGetOAuthConfigReturnsDefaultsAndLiveValues(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if err := oauth.SetConfig(db, "oauth_access_token_ttl_seconds", "7200"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/config", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["dynamicRegistrationEnabled"] != true {
		t.Errorf("expected dynamic registration enabled by default")
	}
	list, _ := resp["config"].([]interface{})
	if len(list) == 0 {
		t.Fatal("expected non-empty config list")
	}
	for _, item := range list {
		row := item.(map[string]interface{})
		if row["key"] == "oauth_access_token_ttl_seconds" && row["value"] != "7200" {
			t.Errorf("expected override value 7200, got %v", row["value"])
		}
	}
}

func TestUpdateOAuthConfigAppliesUpdates(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	r := newAdminServer(t, db)

	body := `{"updates":{"oauth_access_token_ttl_seconds":"1800","oauth_device_poll_interval_seconds":"10"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/oauth/config", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var got string
	if err := db.QueryRow("SELECT value FROM app_config WHERE key = 'oauth_access_token_ttl_seconds'").Scan(&got); err != nil {
		t.Fatalf("query: %v", err)
	}
	if got != "1800" {
		t.Errorf("expected 1800, got %s", got)
	}
}

func TestUpdateOAuthConfigRejectsUnknownKey(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	r := newAdminServer(t, db)

	body := `{"updates":{"oauth_typo":"1"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/oauth/config", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateOAuthConfigRejectsEmpty(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	r := newAdminServer(t, db)

	body := `{"updates":{}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/oauth/config", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}