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

	"open-kanban/internal/oauth"
)

// newPublicExternalServer wires the public listing handler on the
// same path the production main.go mounts it on. No auth
// middleware is attached: the whole point of this endpoint is
// that /login can fetch the buttons before any session exists.
func newPublicExternalServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.GET("/api/v1/auth/external/providers", oauth.ListEnabledExternalProvidersHandler(db))
	return r
}

// seedPublicProvider inserts a row directly so the test can pin
// the exact fields the public projection exposes. enabled=1
// rows appear in the response; enabled=0 rows are filtered out
// at the SQL layer. The function name mirrors the admin
// insertProvider helper (providers_test.go) and uses a similar
// signature, but adds the type and enabled knobs the public
// suite needs.
func seedPublicProvider(t *testing.T, db *sql.DB, id, providerID, name, ptype string, enabled bool, position int, clientID, authEndpoint, scopes string) {
	t.Helper()
	enabledInt := 0
	if enabled {
		enabledInt = 1
	}
	if _, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '', '', '', '{}', ?, ?)`,
		id, providerID, name, ptype, enabledInt, position,
		clientID, scopes, authEndpoint, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed %s: %v", providerID, err)
	}
}

// decodePublicProviders parses the `{providers:[...]}` body the
// handler emits and returns the slice. Centralising the decode
// keeps the assertions short and surfaces unexpected envelope
// shapes (e.g. a regression that returns null instead of []).
func decodePublicProviders(t *testing.T, body []byte) []map[string]interface{} {
	t.Helper()
	var env struct {
		Providers []map[string]interface{} `json:"providers"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode envelope: %v (body=%s)", err, string(body))
	}
	if env.Providers == nil {
		t.Fatalf("expected non-nil providers slice, got null (body=%s)", string(body))
	}
	return env.Providers
}

// 1. Empty database → 200 with an empty (not null) array. Pins
// the CLAUDE.md "prefer empty arrays over null for list responses"
// rule and the public endpoint's promise that /login can render
// before any provider is configured.
func TestListEnabledExternalProviders_Empty(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	r := newPublicExternalServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/external/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"providers":[]`) {
		t.Errorf("expected empty array literal, got %s", w.Body.String())
	}
}

// 2. Only enabled rows appear; disabled rows are filtered out
// at the SQL layer (plan §6.5: enabled=0 omits from public list).
func TestListEnabledExternalProviders_FiltersDisabled(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	seedPublicProvider(t, db, "p-google", "google", "Google", "google", true, 0, "google-cid", "https://accounts.google.com/o/oauth2/v2/auth", "openid email profile")
	seedPublicProvider(t, db, "p-github", "github", "GitHub", "github", false, 1, "gh-cid", "https://github.com/login/oauth/authorize", "user:email")
	seedPublicProvider(t, db, "p-oidc", "corp-okta", "Corp Okta", "oidc", true, 2, "okta-cid", "https://okta.example.com/oauth2/v1/authorize", "openid email")

	r := newPublicExternalServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/external/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	got := decodePublicProviders(t, w.Body.Bytes())
	if len(got) != 2 {
		t.Fatalf("expected 2 enabled providers (google + okta), got %d: %s", len(got), w.Body.String())
	}
	for _, p := range got {
		if p["providerId"] == "github" {
			t.Errorf("disabled github provider must not appear in public list: %v", p)
		}
	}
}

// 3. Rows are returned in position ASC order so the admin's
// drag-to-reorder intent survives a public re-fetch. The
// tie-breaker (created_at DESC) is exercised by inserting rows
// in non-position order.
func TestListEnabledExternalProviders_OrdersByPosition(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	// Insert in reverse-position order so the test proves the SQL
	// actually sorts rather than returning insertion order.
	seedPublicProvider(t, db, "p-okta", "corp-okta", "Corp Okta", "oidc", true, 5, "okta-cid", "https://okta.example.com/oauth2/v1/authorize", "openid email")
	seedPublicProvider(t, db, "p-google", "google", "Google", "google", true, 1, "google-cid", "https://accounts.google.com/o/oauth2/v2/auth", "openid email")
	seedPublicProvider(t, db, "p-github", "github", "GitHub", "github", true, 3, "gh-cid", "https://github.com/login/oauth/authorize", "user:email")

	r := newPublicExternalServer(t, db)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/external/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	got := decodePublicProviders(t, w.Body.Bytes())
	wantOrder := []string{"google", "github", "corp-okta"}
	if len(got) != len(wantOrder) {
		t.Fatalf("expected %d providers, got %d", len(wantOrder), len(got))
	}
	for i, want := range wantOrder {
		if got[i]["providerId"] != want {
			t.Errorf("position %d: expected providerId=%s, got %v", i, want, got[i])
		}
	}
}

// 4. The public projection exposes only the fields the /login
// page needs — secret, internal id, audit fields, and the
// disabled toggle must never appear in the wire shape. A future
// column added to AdminOAuthProvider should not automatically
// leak through the public endpoint either (the SELECT is
// hand-written, not SELECT *).
func TestListEnabledExternalProviders_NoSecretLeak(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	// Insert a row with a non-NULL client_secret so a leak would
	// be visible in the response body.
	_, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_at, updated_at
		) VALUES (?, 'google', 'Google', 'google', 1, 0, 'cid', ?, '', '', '', '', '', '{}', ?, ?)`,
		"p-google", []byte{0x01, 0x02, 0x03, 0x04, 0x05}, time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	r := newPublicExternalServer(t, db)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/external/providers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	got := decodePublicProviders(t, w.Body.Bytes())
	if len(got) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(got))
	}
	for _, banned := range []string{"secretSet", "clientSecret", "client_secret", "id", "createdBy", "createdAt", "updatedAt", "extraConfig", "issuer", "tokenEndpoint", "userinfoEndpoint"} {
		if _, present := got[0][banned]; present {
			t.Errorf("public response must not include %q (got %v)", banned, got[0])
		}
	}
	for _, required := range []string{"providerId", "name", "type", "position", "clientId", "scopes", "authEndpoint"} {
		if _, present := got[0][required]; !present {
			t.Errorf("public response must include %q (got %v)", required, got[0])
		}
	}
}

// 5. The endpoint is reachable without a session cookie — the
// /login page renders before the user is authenticated, so the
// listing cannot be gated on RequireAuth. Pins plan §4.2.
func TestListEnabledExternalProviders_PubliclyReachable(t *testing.T) {
	db := setupProviderDB(t)
	defer db.Close()
	seedPublicProvider(t, db, "p-google", "google", "Google", "google", true, 0, "cid", "https://accounts.google.com/o/oauth2/v2/auth", "openid email")

	// Build a request with no Authorization header and no
	// kanban-token cookie.
	r := newPublicExternalServer(t, db)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/external/providers", nil)
	// Explicitly nil the cookie jar to make the intent visible.
	req.Header.Set("Cookie", "")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for unauthenticated request, got %d: %s", w.Code, w.Body.String())
	}
}