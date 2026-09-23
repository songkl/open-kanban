package oauth_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/oauth"
)

func setupRegisterDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	schema := `
	CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
	CREATE TABLE oauth_clients (
		id TEXT PRIMARY KEY,
		client_id TEXT UNIQUE NOT NULL,
		client_secret_hash TEXT,
		name TEXT NOT NULL,
		redirect_uris TEXT NOT NULL DEFAULT '[]',
		grant_types TEXT NOT NULL DEFAULT '[]',
		token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
		scopes TEXT NOT NULL DEFAULT '[]',
		is_first_party BOOLEAN DEFAULT 0,
		created_by_user_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func newRegisterServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.POST("/oauth/register", oauth.RegisterClient(db))
	return r
}

func doRegister(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestRegisterPublicClientSuccess(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{
		"client_name": "open-kanban-mcp",
		"token_endpoint_auth_method": "none",
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
	}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["client_id"] == nil {
		t.Error("expected client_id in response")
	}
	if resp["client_secret"] != nil && resp["client_secret"] != "" {
		t.Errorf("public client must not receive client_secret, got %v", resp["client_secret"])
	}
	if resp["client_name"] != "open-kanban-mcp" {
		t.Errorf("client_name mismatch: %v", resp["client_name"])
	}
	if method, _ := resp["token_endpoint_auth_method"].(string); method != "none" {
		t.Errorf("expected method none, got %s", method)
	}
	if resp["scope"] == nil {
		t.Error("expected default scope to be advertised")
	}

	// Row should be persisted without a secret.
	var secret sql.NullString
	if err := db.QueryRow("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?", resp["client_id"]).Scan(&secret); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if secret.Valid {
		t.Errorf("expected NULL secret hash for public client, got %q", secret.String)
	}
}

func TestRegisterConfidentialClientIssuesSecretOnce(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{
		"client_name": "backend-service",
		"token_endpoint_auth_method": "client_secret_basic",
		"redirect_uris": ["https://example.com/cb"],
		"grant_types": ["authorization_code", "refresh_token"],
		"scope": "kanban:read tasks:write"
	}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	secret, ok := resp["client_secret"].(string)
	if !ok || secret == "" {
		t.Fatal("expected client_secret for confidential client")
	}
	if len(secret) < 32 {
		t.Errorf("expected secret to be at least 32 chars, got %d", len(secret))
	}

	// The stored hash should verify against the plaintext secret.
	var hash string
	if err := db.QueryRow("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?", resp["client_id"]).Scan(&hash); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if hash == secret {
		t.Error("stored hash must not equal plaintext secret")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(secret)); err != nil {
		t.Errorf("bcrypt verify failed: %v", err)
	}
}

func TestRegisterRejectsInvalidAuthMethod(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "token_endpoint_auth_method": "private_key_jwt"}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_client_metadata" {
		t.Errorf("expected invalid_client_metadata, got %v", resp)
	}
}

func TestRegisterRejectsUnsupportedGrantType(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "grant_types": ["password"]}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRegisterRejectsUnsupportedScope(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "scope": "kanban:read admin:everything"}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRegisterRejectsDisallowedRedirectURI(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "redirect_uris": ["http://example.com/cb"]}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for public http redirect, got %d", w.Code)
	}
}

func TestRegisterAllowsLoopbackRedirectURI(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "redirect_uris": ["http://127.0.0.1:8765/cb", "http://localhost:9000/cb"]}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestRegisterRequiresRedirectURIForConfidentialClient(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "x", "token_endpoint_auth_method": "client_secret_basic"}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRegisterDisabledByConfig(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('oauth_allow_dynamic_client_registration', '0')`); err != nil {
		t.Fatalf("insert config: %v", err)
	}
	r := newRegisterServer(t, db)

	body := `{"client_name": "x"}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "access_denied" {
		t.Errorf("expected access_denied, got %v", resp)
	}
}

func TestRegisterInvalidJSON(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	w := doRegister(t, r, "{not json")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRegisterClientNameTooLong(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{"client_name": "` + strings.Repeat("a", 200) + `"}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRegisterSetsCacheAndPragma(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	w := doRegister(t, r, `{"client_name": "x"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}
	if pr := w.Header().Get("Pragma"); pr != "no-cache" {
		t.Errorf("expected Pragma: no-cache, got %q", pr)
	}
}

func TestGetClientAndHelpers(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{
		"client_name": "svc",
		"token_endpoint_auth_method": "client_secret_basic",
		"redirect_uris": ["https://example.com/cb"],
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		"scope": "kanban:read tasks:write"
	}`
	w := doRegister(t, r, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("register failed: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	client, err := oauth.GetClient(db, resp["client_id"].(string))
	if err != nil {
		t.Fatalf("GetClient: %v", err)
	}
	if client.Name != "svc" {
		t.Errorf("name mismatch: %s", client.Name)
	}
	if !oauth.ClientAllowsGrant(client, "urn:ietf:params:oauth:grant-type:device_code") {
		t.Error("expected device_code grant allowed")
	}
	if oauth.ClientAllowsGrant(client, "password") {
		t.Error("did not expect password grant allowed")
	}
	if !oauth.ClientAllowsScope(client, "kanban:read") {
		t.Error("expected kanban:read allowed")
	}
	if oauth.ClientAllowsScope(client, "boards:admin") {
		t.Error("did not expect boards:admin (not in registered scope)")
	}

	secret := resp["client_secret"].(string)
	if err := oauth.VerifyClientSecret(client, secret); err != nil {
		t.Errorf("VerifyClientSecret: %v", err)
	}
	if err := oauth.VerifyClientSecret(client, "wrong"); err == nil {
		t.Error("expected wrong secret to fail")
	}
}

func TestRegisterBodyBufferReset(t *testing.T) {
	// Re-registers across multiple bodies to make sure no module-level
	// state leaks between requests.
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)
	for i := 0; i < 3; i++ {
		body := `{"client_name": "client-` + strings.Repeat("a", i+1) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/oauth/register", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("iter %d: expected 201, got %d: %s", i, w.Code, w.Body.String())
		}
	}
}

// s-1284: re-registering the same CLI / MCP client with the same
// (name, auth method, grants, scopes) tuple must return the existing
// client_id instead of minting a new oauth_clients row. This is the
// fix for the duplicate-client symptom where a single operator could
// end up with four separate "open-kanban-cli" entries on the admin
// OAuth tab after the local credential store was wiped a few times.
func TestRegisterDedupesByNameAuthMethodGrantsScopes(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{
		"client_name": "open-kanban-cli",
		"token_endpoint_auth_method": "none",
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		"scope": "kanban:read tasks:write comments:write"
	}`

	// First registration: a new client_id is issued.
	w1 := doRegister(t, r, body)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d: %s", w1.Code, w1.Body.String())
	}
	var first map[string]interface{}
	if err := json.Unmarshal(w1.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	firstID, _ := first["client_id"].(string)
	if firstID == "" {
		t.Fatal("first register: client_id missing")
	}

	// Second registration with the same shape: dedup must kick in.
	w2 := doRegister(t, r, body)
	if w2.Code != http.StatusCreated {
		t.Fatalf("second register: expected 201, got %d: %s", w2.Code, w2.Body.String())
	}
	var second map[string]interface{}
	if err := json.Unmarshal(w2.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	secondID, _ := second["client_id"].(string)
	if secondID != firstID {
		t.Fatalf("expected dedup to return existing client_id %q, got %q", firstID, secondID)
	}
	// The dedup response must not invent a new client_secret on every
	// call: if the original was a public client, no secret is ever
	// minted, and a "re-registration" that re-uses the same row must
	// keep that invariant.
	if _, ok := second["client_secret"]; ok {
		t.Errorf("dedup response leaked client_secret: %v", second["client_secret"])
	}

	// And there should be exactly one row in the table for this name.
	var rows int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM oauth_clients WHERE name = 'open-kanban-cli'`,
	).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 1 {
		t.Errorf("expected 1 oauth_clients row for deduped name, got %d", rows)
	}
}

// s-1284: dedup must be a strict match on the (name, auth_method) tuple
// AND a subset match on grants + scopes. A caller asking for a wider
// scope set than what is on file should still get a fresh row so we
// don't silently widen an existing identity's privileges.
func TestRegisterDoesNotDedupWhenScopeIsWider(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	first := `{
		"client_name": "open-kanban-cli",
		"token_endpoint_auth_method": "none",
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		"scope": "kanban:read"
	}`
	second := `{
		"client_name": "open-kanban-cli",
		"token_endpoint_auth_method": "none",
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		"scope": "kanban:read tasks:write"
	}`

	w1 := doRegister(t, r, first)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d: %s", w1.Code, w1.Body.String())
	}
	var firstBody map[string]interface{}
	_ = json.Unmarshal(w1.Body.Bytes(), &firstBody)
	firstID, _ := firstBody["client_id"].(string)

	w2 := doRegister(t, r, second)
	if w2.Code != http.StatusCreated {
		t.Fatalf("second register: expected 201, got %d: %s", w2.Code, w2.Body.String())
	}
	var secondBody map[string]interface{}
	_ = json.Unmarshal(w2.Body.Bytes(), &secondBody)
	secondID, _ := secondBody["client_id"].(string)
	if secondID == firstID {
		t.Errorf("expected a fresh client_id for a wider scope set, but got the same %q", firstID)
	}

	var rows int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM oauth_clients WHERE name = 'open-kanban-cli'`,
	).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 2 {
		t.Errorf("expected 2 rows after non-matching re-register, got %d", rows)
	}
}

// s-1284: a different client_name keeps the dedup contract — two tools
// with distinct names must not collapse onto the same client_id, even
// when grants and scopes happen to match.
func TestRegisterDoesNotDedupAcrossNames(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	makeBody := func(name string) string {
		return fmt.Sprintf(`{
			"client_name": %q,
			"token_endpoint_auth_method": "none",
			"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
			"scope": "kanban:read tasks:write"
		}`, name)
	}

	w1 := doRegister(t, r, makeBody("open-kanban-cli"))
	if w1.Code != http.StatusCreated {
		t.Fatalf("cli register: expected 201, got %d: %s", w1.Code, w1.Body.String())
	}
	w2 := doRegister(t, r, makeBody("open-kanban-mcp"))
	if w2.Code != http.StatusCreated {
		t.Fatalf("mcp register: expected 201, got %d: %s", w2.Code, w2.Body.String())
	}
	var cliBody, mcpBody map[string]interface{}
	_ = json.Unmarshal(w1.Body.Bytes(), &cliBody)
	_ = json.Unmarshal(w2.Body.Bytes(), &mcpBody)
	if cliBody["client_id"] == mcpBody["client_id"] {
		t.Errorf("expected distinct client_ids for distinct client_names, both got %v", cliBody["client_id"])
	}
}

// s-1284: confidential clients must also dedup. A re-registration must
// not mint a *new* client_secret on every call — only the original
// registration returns the secret once; subsequent matches reuse the
// existing client_id and never expose the stored bcrypt hash.
func TestRegisterDedupesConfidentialClient(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	r := newRegisterServer(t, db)

	body := `{
		"client_name": "backend-service",
		"token_endpoint_auth_method": "client_secret_basic",
		"redirect_uris": ["https://example.com/cb"],
		"grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		"scope": "kanban:read tasks:write"
	}`

	w1 := doRegister(t, r, body)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d: %s", w1.Code, w1.Body.String())
	}
	var first map[string]interface{}
	_ = json.Unmarshal(w1.Body.Bytes(), &first)
	firstID, _ := first["client_id"].(string)
	if firstID == "" {
		t.Fatal("first register: client_id missing")
	}

	w2 := doRegister(t, r, body)
	if w2.Code != http.StatusCreated {
		t.Fatalf("second register: expected 201, got %d: %s", w2.Code, w2.Body.String())
	}
	var second map[string]interface{}
	_ = json.Unmarshal(w2.Body.Bytes(), &second)
	if secondID, _ := second["client_id"].(string); secondID != firstID {
		t.Errorf("expected dedup to reuse %q, got %q", firstID, secondID)
	}
	// Critically: the dedup path must NOT re-issue a client_secret.
	// Doing so would re-roll the secret and silently invalidate the
	// operator's stored credential on every retry.
	if _, ok := second["client_secret"]; ok {
		t.Errorf("dedup response leaked a fresh client_secret: %v", second["client_secret"])
	}
}
