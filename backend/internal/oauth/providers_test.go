package oauth_test

import (
	"bytes"
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
	"open-kanban/internal/models"
	"open-kanban/internal/oauth"
)

// setupProviderDB returns an in-memory SQLite with the minimum schema
// the CRUD handlers touch: users (for role/created_by FK), tokens (for
// the auth-when-enabled middleware to short-circuit), and
// oauth_providers (migration 009 schema).
func setupProviderDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupApproveDB(t)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS oauth_providers (
			id                  TEXT PRIMARY KEY,
			provider_id         TEXT NOT NULL UNIQUE,
			name                TEXT NOT NULL,
			type                TEXT NOT NULL CHECK(type IN (
				'google', 'github', 'wecom', 'feishu', 'dingtalk', 'oidc'
			)),
			enabled             INTEGER NOT NULL DEFAULT 1,
			position            INTEGER NOT NULL DEFAULT 0,
			client_id           TEXT NOT NULL,
			client_secret       BLOB,
			scopes              TEXT NOT NULL DEFAULT '',
			auth_endpoint       TEXT NOT NULL DEFAULT '',
			token_endpoint      TEXT NOT NULL DEFAULT '',
			userinfo_endpoint   TEXT NOT NULL DEFAULT '',
			issuer              TEXT NOT NULL DEFAULT '',
			extra_config        TEXT NOT NULL DEFAULT '{}',
			created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
			created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_oauth_providers_enabled ON oauth_providers(enabled);
	`); err != nil {
		t.Fatalf("oauth_providers schema: %v", err)
	}
	return db
}

// newProviderServer wires the CRUD routes with the same RequireAuth
// middleware used in production so role checks fire exactly the way
// they will when this is mounted on /api/v1/auth.
func newProviderServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	auth := r.Group("", handlers.RequireAuth(db))
	auth.GET("/api/v1/oauth/providers", oauth.ListAdminProvidersHandler(db))
	auth.POST("/api/v1/oauth/providers", oauth.CreateAdminProviderHandler(db))
	auth.GET("/api/v1/oauth/providers/:id", oauth.GetAdminProviderHandler(db))
	auth.PUT("/api/v1/oauth/providers/:id", oauth.UpdateAdminProviderHandler(db))
	auth.DELETE("/api/v1/oauth/providers/:id", oauth.DeleteAdminProviderHandler(db))
	return r
}

// newProviderServerAsAdmin builds a router whose every request is
// forced into the supplied role. The full RequireAuth middleware is
// intentionally omitted so the suite can probe the admin gate in
// isolation (test 1 covers the 401 path via the real middleware).
func newProviderServerAsAdmin(t *testing.T, db *sql.DB, callerRole string) *gin.Engine {
	t.Helper()
	return newProviderServerAsUser(t, db, &models.User{
		ID:       "test-caller",
		Username: "test-caller",
		Role:     callerRole,
		Enabled:  true,
	})
}

// newProviderServerAsUser builds a router that injects a fixed
// *models.User into the gin context. Useful for the created_by FK
// test which needs a specific admin id rather than the default.
func newProviderServerAsUser(t *testing.T, db *sql.DB, u *models.User) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("user", u)
		c.Next()
	})
	r.GET("/api/v1/oauth/providers", oauth.ListAdminProvidersHandler(db))
	r.POST("/api/v1/oauth/providers", oauth.CreateAdminProviderHandler(db))
	r.GET("/api/v1/oauth/providers/:id", oauth.GetAdminProviderHandler(db))
	r.PUT("/api/v1/oauth/providers/:id", oauth.UpdateAdminProviderHandler(db))
	r.DELETE("/api/v1/oauth/providers/:id", oauth.DeleteAdminProviderHandler(db))
	return r
}

func init() {
	gin.SetMode(gin.TestMode)
}

// 1. Unauthenticated GET is rejected by RequireAuth before any
// handler runs. Pins the auth-first contract documented on the
// admin gate.
func TestAdminProviders_UnauthenticatedRejected(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

// 2. Non-admin caller gets 403 — the gate is the single source of
// truth for role enforcement.
func TestAdminProviders_NonAdminForbidden(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "MEMBER")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// 3. Admin can create a provider. client_secret is stored encrypted
// (BLOB), and the response redacts the secret (only secretSet=true
// surfaces). Pins plan §6.1 and §6.2.
func TestAdminProviders_CreateRoundTrip(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"position": 0,
		"clientId": "google-client-id",
		"clientSecret": "shhh-very-secret",
		"scopes": "openid email profile",
		"extraConfig": "{\"default_role\":\"USER\"}"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())

	// Wire shape must redacted the secret.
	if resp["clientSecret"] != nil {
		t.Errorf("clientSecret leaked in response: %v", resp["clientSecret"])
	}
	if resp["secretSet"] != true {
		t.Errorf("expected secretSet=true, got %v", resp["secretSet"])
	}
	if resp["providerId"] != "google" {
		t.Errorf("providerId mismatch: %v", resp["providerId"])
	}

	// DB must store the ciphertext, never the plaintext.
	var stored []byte
	if err := db.QueryRow(`SELECT client_secret FROM oauth_providers WHERE id = ?`, resp["id"]).Scan(&stored); err != nil {
		t.Fatalf("query secret: %v", err)
	}
	if len(stored) <= 12 {
		t.Fatalf("expected nonce-prefixed ciphertext, got %d bytes", len(stored))
	}
	if bytes.Contains(stored, []byte("shhh-very-secret")) {
		t.Errorf("plaintext leaked into the BLOB column")
	}
	// Sanity: the ciphertext can be decrypted back to the original.
	plain, err := oauth.DecryptProviderSecret(stored)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != "shhh-very-secret" {
		t.Errorf("decrypt mismatch: %q", plain)
	}
}

// 4. Creating a provider without the encryption key configured
// returns 503 so the operator notices the misconfiguration instead
// of falling back to plaintext (plan §6.2 fail-closed).
func TestAdminProviders_CreateWithoutEncryptionKeyFails(t *testing.T) {
	withProviderSecretKey(t, "")
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
	}
}

// 5. Validation rejects an unknown type with 400 and the offending
// field name surfaced in the message.
func TestAdminProviders_CreateRejectsUnknownType(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "okta",
		"name": "Okta",
		"type": "okta",
		"clientId": "x",
		"clientSecret": "y"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "type") {
		t.Errorf("expected error to mention `type`, got: %s", w.Body.String())
	}
}

// 6. Validation rejects a bad provider_id slug.
func TestAdminProviders_CreateRejectsBadSlug(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "Bad Slug",
		"name": "X",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 7. issuer is required when type=oidc.
func TestAdminProviders_CreateOIDCRequiresIssuer(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "corp",
		"name": "Corp",
		"type": "oidc",
		"clientId": "x",
		"clientSecret": "y"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "issuer") {
		t.Errorf("expected error to mention `issuer`, got: %s", w.Body.String())
	}
}

// 8. URLs must be https (http only allowed for localhost).
func TestAdminProviders_CreateRejectsInsecureURL(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y",
		"authEndpoint": "http://evil.example.com/auth"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 9. http://localhost is allowed for self-hosted testing.
func TestAdminProviders_CreateAllowsLocalhostHTTP(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "local",
		"name": "Local",
		"type": "oidc",
		"clientId": "x",
		"clientSecret": "y",
		"issuer": "http://localhost:8080/realms/test",
		"authEndpoint": "http://localhost:8080/auth",
		"tokenEndpoint": "http://localhost:8080/token",
		"userinfoEndpoint": "http://localhost:8080/userinfo"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

// 10. Duplicate providerId returns 409.
func TestAdminProviders_CreateRejectsDuplicateProviderID(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y"
	}`
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if i == 0 && w.Code != http.StatusCreated {
			t.Fatalf("seed create: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		if i == 1 && w.Code != http.StatusConflict {
			t.Fatalf("expected 409 on duplicate, got %d: %s", w.Code, w.Body.String())
		}
	}
}

// 11. Public-client providers (no secret) succeed with secretSet=false.
func TestAdminProviders_CreatePublicClientHasNoSecret(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "public",
		"name": "Public",
		"type": "github",
		"clientId": "x"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if resp["secretSet"] != false {
		t.Errorf("expected secretSet=false for public client, got %v", resp["secretSet"])
	}
}

// 12. List returns rows ordered by position then created_at desc,
// and the secret is never on the wire.
func TestAdminProviders_ListOrdersByPosition(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	insertProvider(t, db, "p1", "google", "Google", 1, "google-client", []byte("encrypted"))
	insertProvider(t, db, "p2", "github", "GitHub", 0, "gh-client", nil)
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	providers, _ := resp["providers"].([]interface{})
	if len(providers) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(providers))
	}
	first := providers[0].(map[string]interface{})
	if first["providerId"] != "github" {
		t.Errorf("expected github first (position=0), got %v", first["providerId"])
	}
	if first["secretSet"] != false {
		t.Errorf("expected secretSet=false for nil secret, got %v", first["secretSet"])
	}
	second := providers[1].(map[string]interface{})
	if second["secretSet"] != true {
		t.Errorf("expected secretSet=true for present secret, got %v", second["secretSet"])
	}
}

// 13. Update changes only the supplied fields and re-encrypts when
// clientSecret is provided.
func TestAdminProviders_UpdatePartial(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	insertProvider(t, db, "p1", "google", "Google Old", 0, "client-1", []byte("old-cipher"))
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{"name": "Google New", "clientSecret": "new-secret"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/p1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if resp["name"] != "Google New" {
		t.Errorf("name not updated: %v", resp["name"])
	}
	if resp["providerId"] != "google" {
		t.Errorf("providerId mutated: %v", resp["providerId"])
	}

	// Confirm the new secret was encrypted and the old one is gone.
	var stored []byte
	if err := db.QueryRow(`SELECT client_secret FROM oauth_providers WHERE id = 'p1'`).Scan(&stored); err != nil {
		t.Fatalf("query: %v", err)
	}
	plain, err := oauth.DecryptProviderSecret(stored)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != "new-secret" {
		t.Errorf("expected new secret, got %q", plain)
	}
}

// 14. Update with no clientSecret keeps the existing ciphertext.
func TestAdminProviders_UpdateKeepsSecret(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	original := []byte("encrypted-old-secret")
	insertProvider(t, db, "p1", "google", "Google", 0, "client-1", original)
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{"name": "Renamed"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/p1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var stored []byte
	if err := db.QueryRow(`SELECT client_secret FROM oauth_providers WHERE id = 'p1'`).Scan(&stored); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !bytes.Equal(stored, original) {
		t.Errorf("expected ciphertext unchanged, got %x (was %x)", stored, original)
	}
}

// 15. Update on a missing id returns 404.
func TestAdminProviders_UpdateNotFound(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{"name": "Anything"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/missing", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 16. Update validates the merged payload so a typo in a previously-
// valid field becomes 400, not silent corruption.
func TestAdminProviders_UpdateRejectsInvalidMerged(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	insertProvider(t, db, "p1", "google", "Google", 0, "client-1", []byte("enc"))
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{"scopes": "good:scope bad!!scope"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/p1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 17. Delete removes the row and returns 200 with the id echoed.
func TestAdminProviders_DeleteRemovesRow(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	insertProvider(t, db, "p1", "google", "Google", 0, "client-1", []byte("enc"))
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/oauth/providers/p1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM oauth_providers WHERE id = 'p1'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("expected row deleted, found %d", n)
	}
}

// 18. Delete on a missing id returns 404.
func TestAdminProviders_DeleteNotFound(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/oauth/providers/missing", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 19. Get returns a single row in the same redacted shape.
func TestAdminProviders_GetReturnsRedacted(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	insertProvider(t, db, "p1", "google", "Google", 0, "client-1", []byte("enc"))
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers/p1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if resp["clientSecret"] != nil {
		t.Errorf("clientSecret leaked: %v", resp["clientSecret"])
	}
	if resp["secretSet"] != true {
		t.Errorf("expected secretSet=true, got %v", resp["secretSet"])
	}
}

// 20. Get on a missing id returns 404.
func TestAdminProviders_GetNotFound(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers/missing", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 21. created_by is populated from the caller so the audit trail
// pins each provider to the admin who configured it.
func TestAdminProviders_CreateStampsCreatedBy(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	// Seed an admin user with id "admin-1" so the FK has a target.
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, type, role, enabled)
		 VALUES ('admin-1', 'admin', 'Admin', 'HUMAN', 'ADMIN', 1)`,
	); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	r := newProviderServerAsUser(t, db, &models.User{
		ID: "admin-1", Username: "admin", Role: "ADMIN", Enabled: true,
	})

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if resp["createdBy"] != "admin-1" {
		t.Errorf("expected createdBy=admin-1, got %v", resp["createdBy"])
	}
	var storedBy sql.NullString
	if err := db.QueryRow(`SELECT created_by FROM oauth_providers WHERE id = ?`, resp["id"]).Scan(&storedBy); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !storedBy.Valid || storedBy.String != "admin-1" {
		t.Errorf("DB created_by mismatch: %v", storedBy)
	}
}

// 22. extra_config must be a JSON object — arrays and primitives
// surface as 400 so the column never holds a value that breaks
// downstream JSON parsing.
func TestAdminProviders_CreateRejectsNonObjectExtraConfig(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y",
		"extraConfig": "[1,2,3]"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 23. List returns an empty array (not null) when no providers are
// configured — the frontend can iterate without nil-checking.
func TestAdminProviders_EmptyListIsArray(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/oauth/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	// Decode raw to assert the JSON contains "[]" rather than "null".
	body := w.Body.String()
	if !strings.Contains(body, `"providers":[]`) {
		t.Errorf("expected empty array literal, got %s", body)
	}
}

// 24. Validation rejects a scope token that violates the
// [a-z0-9._:-]{1,64} allow-list. Pins plan §7.5.
func TestAdminProviders_CreateRejectsBadScopeToken(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "x",
		"clientSecret": "y",
		"scopes": "openid BAD!"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// insertProvider seeds an oauth_providers row directly. The
// client_secret argument is stored verbatim (typically an encrypted
// blob from oauth.EncryptProviderSecret, but tests use hand-rolled
// bytes for cases that don't care about round-trip).
func insertProvider(t *testing.T, db *sql.DB, id, providerID, name string, position int, clientID string, secret []byte) {
	t.Helper()
	var secretArg interface{}
	if secret != nil {
		secretArg = secret
	}
	if _, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_at, updated_at
		) VALUES (?, ?, ?, 'google', 1, ?, ?, ?, '', '', '', '', '', '{}', ?, ?)`,
		id, providerID, name, position, clientID, secretArg, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("insert provider %s: %v", id, err)
	}
}

// decodeProvider extracts the JSON body when callers don't want to
// repeat the boilerplate.
func decodeProvider(t *testing.T, body []byte) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, string(body))
	}
	return out
}
