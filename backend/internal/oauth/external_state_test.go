package oauth_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/oauth"
)

// setupStateDB extends setupCallbackDB with the pending_oauth_states
// table from migration 011. The callback-state tests need both
// oauth_providers and pending_oauth_states wired up so the
// login / callback handlers can exercise the CSRF flow
// end-to-end.
func setupStateDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupCallbackDB(t)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS pending_oauth_states (
			id              TEXT PRIMARY KEY,
			state           TEXT NOT NULL UNIQUE,
			provider_id     TEXT NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
			code_verifier   TEXT NOT NULL,
			code_challenge  TEXT NOT NULL,
			redirect_after  TEXT NOT NULL DEFAULT '',
			created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
			expires_at      DATETIME NOT NULL,
			consumed_at     DATETIME
		)`); err != nil {
		t.Fatalf("pending_oauth_states schema: %v", err)
	}
	return db
}

// newLoginServer wires the public login + callback routes with
// the supplied fetcher injected. Mirrors the production
// /oauth/external/:slug/{login,callback} surface so the test
// suite can pin both the 302 redirect and the state-validation
// branches.
func newLoginServer(t *testing.T, db *sql.DB, fetcher oauth.UserinfoFetcher) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))
	r.GET("/oauth/external/:slug/callback", oauth.ExternalCallbackHandlerWithFetcherForTest(db, fetcher))
	r.POST("/oauth/external/:slug/callback", oauth.ExternalCallbackHandlerWithFetcherForTest(db, fetcher))
	return r
}

// seedStateProvider inserts an oauth_providers row whose
// endpoints point at the supplied test server so the login
// handler can build an authorize URL pointing back to it.
func seedStateProvider(t *testing.T, db *sql.DB, slug, authEndpoint string) string {
	t.Helper()
	id := "prov-" + slug
	if _, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_at, updated_at
		) VALUES (?, ?, ?, 'google', 1, 0, ?, NULL, 'openid email profile',
		          ?, 'https://idp.test/token', 'https://idp.test/userinfo',
		          '', '{}', ?, ?)`,
		id, slug, "Test "+slug, "client-"+slug, authEndpoint, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	return id
}

// countPendingStates is a tiny helper used by the housekeeping
// tests. Returning 0 / N from a count(*) scan in the test
// bodies would work but adds noise.
func countPendingStates(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending_oauth_states`).Scan(&n); err != nil {
		t.Fatalf("count pending states: %v", err)
	}
	return n
}

// ===================== Crypto / encoding helpers =====================

// 1. generateOpaqueState returns a 43-char base64url string —
//    the canonical CSRF token shape per plan §7.1.
func TestGenerateOpaqueState_Shape(t *testing.T) {
	state, err := oauth.GenerateOpaqueStateForTest()
	if err != nil {
		t.Fatalf("GenerateOpaqueState: %v", err)
	}
	if len(state) != 43 {
		t.Errorf("expected state length 43, got %d (%q)", len(state), state)
	}
	if _, err := base64.RawURLEncoding.DecodeString(state); err != nil {
		t.Errorf("state is not valid base64url: %v (%q)", err, state)
	}
}

// 2. Two consecutive state generations must differ — the
//    generator must not be deterministic.
func TestGenerateOpaqueState_Unique(t *testing.T) {
	a, err := oauth.GenerateOpaqueStateForTest()
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	b, err := oauth.GenerateOpaqueStateForTest()
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if a == b {
		t.Errorf("two consecutive states collided: %q", a)
	}
}

// 3. PKCE pair: verifier is 43-char base64url, challenge is
//    base64url(SHA-256(verifier)). Pin RFC 7636 §4.2 / §4.3.
func TestGeneratePKCEPair_SHA256(t *testing.T) {
	verifier, challenge, err := oauth.GeneratePKCEPairForTest()
	if err != nil {
		t.Fatalf("GeneratePKCEPair: %v", err)
	}
	if len(verifier) != 43 {
		t.Errorf("expected verifier length 43, got %d (%q)", len(verifier), verifier)
	}
	if _, err := base64.RawURLEncoding.DecodeString(verifier); err != nil {
		t.Errorf("verifier is not valid base64url: %v (%q)", err, verifier)
	}
	want := base64.RawURLEncoding.EncodeToString(sumSHA256([]byte(verifier)))
	if challenge != want {
		t.Errorf("challenge mismatch: want %q, got %q", want, challenge)
	}
}

// sumSHA256 is the explicit SHA-256 the production code uses
// in external_state.go; lifted into the test so the assertion
// above is independent of crypto/sha256's API surface.
func sumSHA256(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

// ===================== persistPendingState / ConsumePendingState =====================

// 4. persistPendingState writes a row that ConsumePendingState
//    can look up, expire, and consume.
func TestPendingState_RoundTrip(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-rt", "verifier-rt", "challenge-rt", "/board/1", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}

	got, err := oauth.ConsumePendingState(context.Background(), db, "state-rt", providerID)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got.ProviderID != providerID {
		t.Errorf("expected ProviderID=%s, got %s", providerID, got.ProviderID)
	}
	if got.CodeVerifier != "verifier-rt" {
		t.Errorf("expected verifier 'verifier-rt', got %q", got.CodeVerifier)
	}
	if got.CodeChallenge != "challenge-rt" {
		t.Errorf("expected challenge 'challenge-rt', got %q", got.CodeChallenge)
	}
	if got.RedirectAfter != "/board/1" {
		t.Errorf("expected redirect_after '/board/1', got %q", got.RedirectAfter)
	}
	if !got.ConsumedAt.Valid {
		t.Errorf("expected ConsumedAt to be stamped on success")
	}

	// A second consume must refuse — one-shot enforcement.
	if _, err := oauth.ConsumePendingState(context.Background(), db, "state-rt", providerID); !errors.Is(err, oauth.ErrPendingStateConsumed) {
		t.Errorf("expected ErrPendingStateConsumed on replay, got %v", err)
	}
}

// 5. Unknown state value → ErrPendingStateNotFound. Pins the
//    callback handler's 400 response when an attacker submits
//    a guess that doesn't match any minted row.
func TestConsumePendingState_NotFound(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	if _, err := oauth.ConsumePendingState(context.Background(), db, "no-such-state", ""); !errors.Is(err, oauth.ErrPendingStateNotFound) {
		t.Errorf("expected ErrPendingStateNotFound, got %v", err)
	}
}

// 6. Empty state value → ErrPendingStateNotFound. Pins the
//    handler's 400 response when an attacker submits an empty
//    state to provoke a SQL error or a slow scan.
func TestConsumePendingState_Empty(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	if _, err := oauth.ConsumePendingState(context.Background(), db, "", ""); !errors.Is(err, oauth.ErrPendingStateNotFound) {
		t.Errorf("expected ErrPendingStateNotFound for empty state, got %v", err)
	}
}

// 7. Expired state value → ErrPendingStateExpired. Pins the
//    handler's 400 when a row was minted more than
//    PendingStateTTL ago.
func TestConsumePendingState_Expired(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(-1 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-exp", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if _, err := oauth.ConsumePendingState(context.Background(), db, "state-exp", providerID); !errors.Is(err, oauth.ErrPendingStateExpired) {
		t.Errorf("expected ErrPendingStateExpired, got %v", err)
	}
}

// 8. expectedProviderID mismatch → ErrPendingStateWrongProvider.
//    Pin the defence-in-depth check the admin tooling uses.
func TestConsumePendingState_WrongProvider(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-wp", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if _, err := oauth.ConsumePendingState(context.Background(), db, "state-wp", "some-other-provider"); !errors.Is(err, oauth.ErrPendingStateWrongProvider) {
		t.Errorf("expected ErrPendingStateWrongProvider, got %v", err)
	}
}

// 9. ON DELETE CASCADE: removing a provider drops every
//    pending state bound to it. Mirrors the migration test but
//    exercises the seam ConsumePendingState uses.
func TestPendingState_CascadeOnProviderDelete(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-cd", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM oauth_providers WHERE id = ?`, providerID); err != nil {
		t.Fatalf("delete provider: %v", err)
	}
	if got := countPendingStates(t, db); got != 0 {
		t.Errorf("expected cascade to drop pending state, got count=%d", got)
	}
}

// 10. PurgeExpiredPendingStates removes only the rows past
//     their expiry; live rows are kept.
func TestPurgeExpiredPendingStates(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	now := time.Now()

	if err := oauth.PersistPendingStateForTest(db, providerID, "live-state", "v", "c", "", now.Add(10*time.Minute)); err != nil {
		t.Fatalf("persist live: %v", err)
	}
	if err := oauth.PersistPendingStateForTest(db, providerID, "dead-state", "v", "c", "", now.Add(-1*time.Minute)); err != nil {
		t.Fatalf("persist dead: %v", err)
	}

	n, err := oauth.PurgeExpiredPendingStatesForTest(db, now)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n != 1 {
		t.Errorf("expected to purge 1 row, got %d", n)
	}
	if got := countPendingStates(t, db); got != 1 {
		t.Errorf("expected 1 surviving row, got %d", got)
	}
}

// ===================== sanitizeRedirectAfter =====================

// 11. sanitizeRedirectAfter accepts only relative paths and
//     refuses open-redirect attempts (absolute URLs,
//     scheme-relative URLs, empty values).
func TestSanitizeRedirectAfter(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"/board/1", "/board/1"},
		{"/board/1?filter=open", "/board/1?filter=open"},
		{"https://attacker.test/", ""},
		{"//attacker.test/path", ""},
		{"/\\attacker.test", ""},
		{"javascript:alert(1)", ""},
		{"board/1", ""},
		{strings.Repeat("a", 3000), ""},
	}
	for _, tc := range cases {
		got := oauth.SanitizeRedirectAfterForTest(tc.in)
		if got != tc.want {
			t.Errorf("sanitize(%q): want %q, got %q", tc.in, tc.want, got)
		}
	}
}

// ===================== ExternalLoginHandler =====================

// 12. Happy path: GET /oauth/external/:slug/login → 302 to the
//     IdP, sets the state cookie, persists a row. The
//     redirect URL carries state + code_challenge +
//     code_challenge_method=S256 + the provider's client_id +
//     scopes + redirect_uri back to the callback.
func TestExternalLoginHandler_HappyPath(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("idp"))
	}))
	defer idp.Close()
	seedStateProvider(t, db, "google", idp.URL)

	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))

	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/login?redirect=/board/1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d: %s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	if loc == "" {
		t.Fatalf("expected Location header, got empty")
	}
	parsed, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("parse Location: %v", err)
	}
	if parsed.Scheme+"://"+parsed.Host != idp.URL {
		t.Errorf("expected Location host %s, got %s", idp.URL, parsed.Host)
	}
	q := parsed.Query()
	if got := q.Get("response_type"); got != "code" {
		t.Errorf("expected response_type=code, got %q", got)
	}
	if got := q.Get("client_id"); got != "client-google" {
		t.Errorf("expected client_id=client-google, got %q", got)
	}
	if got := q.Get("scope"); got != "openid email profile" {
		t.Errorf("expected scope='openid email profile', got %q", got)
	}
	if got := q.Get("code_challenge_method"); got != "S256" {
		t.Errorf("expected code_challenge_method=S256, got %q", got)
	}
	if q.Get("state") == "" {
		t.Errorf("expected state to be set on the authorize URL")
	}
	if q.Get("code_challenge") == "" {
		t.Errorf("expected code_challenge to be set on the authorize URL")
	}
	if got := q.Get("redirect_uri"); !strings.HasSuffix(got, "/oauth/external/google/callback") {
		t.Errorf("expected redirect_uri to end in /oauth/external/google/callback, got %q", got)
	}

	// Cookie: state + HttpOnly + SameSite=Lax.
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "oauth_ext_state" {
			cookie = c
			break
		}
	}
	if cookie == nil {
		t.Fatalf("expected oauth_ext_state cookie, got %v", w.Result().Cookies())
	}
	if !cookie.HttpOnly {
		t.Errorf("expected HttpOnly=true on state cookie")
	}
	if cookie.Value == "" {
		t.Errorf("expected non-empty cookie value")
	}
	if q.Get("state") != cookie.Value {
		t.Errorf("cookie state and URL state differ: cookie=%q url=%q", cookie.Value, q.Get("state"))
	}

	// Row in pending_oauth_states with redirect_after captured.
	if got := countPendingStates(t, db); got != 1 {
		t.Errorf("expected 1 pending state row, got %d", got)
	}
	var redirectAfter string
	if err := db.QueryRow(`SELECT redirect_after FROM pending_oauth_states`).Scan(&redirectAfter); err != nil {
		t.Fatalf("query redirect_after: %v", err)
	}
	if redirectAfter != "/board/1" {
		t.Errorf("expected redirect_after='/board/1', got %q", redirectAfter)
	}
}

// 13. Unknown slug → 404 (does not leak whether the row exists
//     for a different slug).
func TestExternalLoginHandler_UnknownSlug(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))

	req := httptest.NewRequest(http.MethodGet, "/oauth/external/nope/login", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
	if got := countPendingStates(t, db); got != 0 {
		t.Errorf("expected no pending state to be persisted, got %d", got)
	}
}

// 14. Disabled provider → 404. Same reasoning as the callback
//     handler: the public surface never leaks the existence
//     of a disabled row.
func TestExternalLoginHandler_DisabledProvider(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET enabled = 0 WHERE provider_id = 'google'`); err != nil {
		t.Fatalf("disable: %v", err)
	}

	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/login", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 15. auth_endpoint not configured → 500. Pins the early
//     failure surface so a misconfigured provider can't 302
//     the user to a literal empty string.
func TestExternalLoginHandler_MissingAuthEndpoint(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET auth_endpoint = '' WHERE provider_id = 'google'`); err != nil {
		t.Fatalf("clear auth_endpoint: %v", err)
	}

	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/login", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
}

// 16. Open-redirect guard: ?redirect=https://attacker.test is
//     dropped; the persisted row carries redirect_after=''.
func TestExternalLoginHandler_RejectsOpenRedirect(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer idp.Close()
	seedStateProvider(t, db, "google", idp.URL)

	r := gin.New()
	r.GET("/oauth/external/:slug/login", oauth.ExternalLoginHandler(db))
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/login?redirect=https://attacker.test/", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d: %s", w.Code, w.Body.String())
	}
	var redirectAfter string
	if err := db.QueryRow(`SELECT redirect_after FROM pending_oauth_states`).Scan(&redirectAfter); err != nil {
		t.Fatalf("query redirect_after: %v", err)
	}
	if redirectAfter != "" {
		t.Errorf("expected open-redirect attempt to be dropped, got %q", redirectAfter)
	}
}

// ===================== Callback state validation =====================

// 17. Callback without a state parameter but with a code → 400
//     (the state is mandatory in the production IdP flow).
//     Pins the security check that an attacker can't bypass
//     CSRF by sending only `code`.
func TestExternalCallback_CodeWithoutState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "state") {
		t.Errorf("expected error to mention state, got %s", w.Body.String())
	}
}

// 18. Callback with an unknown state value → 400. Pins the
//     "no row matches" branch.
func TestExternalCallback_UnknownState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=never-minted", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 19. Callback with an expired state value → 400. Pins the
//     "row exists but past TTL" branch.
func TestExternalCallback_ExpiredState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(-1 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-exp", "v", "c", "", expires); err != nil {
		t.Fatalf("persist expired: %v", err)
	}

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=state-exp", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "expired") {
		t.Errorf("expected error to mention expiry, got %s", w.Body.String())
	}
}

// 20. Callback replays the same state twice → second call
//     sees ErrPendingStateConsumed → 400. Pins the one-shot
//     enforcement at the HTTP layer.
func TestExternalCallback_ConsumedState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-once", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})

	req1 := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=state-once", nil)
	w1 := httptest.NewRecorder()
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("first call: expected 200, got %d: %s", w1.Code, w1.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=state-once", nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("replay: expected 400, got %d: %s", w2.Code, w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), "already used") {
		t.Errorf("expected error to mention 'already used', got %s", w2.Body.String())
	}
}

// 21. Cookie mismatch: the request carries a state value
//     that matches the DB row, but the cookie value differs.
//     Pins the same-origin check (defence-in-depth against a
//     CSRF replay off-host).
func TestExternalCallback_CookieMismatch(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-db", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=state-db", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_ext_state", Value: "different-value-from-db"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "cookie") {
		t.Errorf("expected error to mention cookie, got %s", w.Body.String())
	}
}

// 22. POST test-seam path with `claims` (no `code`) must still
//     mint a session — confirms the state-validation block is
//     skipped on the test path so the existing external-callback
//     suite keeps working.
func TestExternalCallback_ClaimsPathBypassesState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	body := `{"claims":{"sub":"sub-1","email":"a@b.com","email_verified":true}}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// 23. Successful callback consumes the state, sets the
//     session cookie, and clears the state cookie so a
//     follow-up request can't accidentally reuse it.
func TestExternalCallback_ConsumesAndClearsState(t *testing.T) {
	db := setupStateDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	expires := time.Now().Add(10 * time.Minute)
	if err := oauth.PersistPendingStateForTest(db, providerID, "state-success", "v", "c", "", expires); err != nil {
		t.Fatalf("persist: %v", err)
	}

	r := newLoginServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})
	req := httptest.NewRequest(http.MethodGet, "/oauth/external/google/callback?code=abc&state=state-success", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_ext_state", Value: "state-success"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// pending_oauth_states.consumed_at must be stamped.
	var consumedAt sql.NullTime
	if err := db.QueryRow(`SELECT consumed_at FROM pending_oauth_states WHERE state = 'state-success'`).Scan(&consumedAt); err != nil {
		t.Fatalf("query consumed_at: %v", err)
	}
	if !consumedAt.Valid {
		t.Errorf("expected consumed_at to be stamped, got NULL")
	}

	// The SetCookie(-1) call must clear the state cookie.
	var cleared bool
	for _, c := range w.Result().Cookies() {
		if c.Name == "oauth_ext_state" && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Errorf("expected oauth_ext_state cookie to be cleared (MaxAge<0), got %v", w.Result().Cookies())
	}

	// Session cookie must be set on success.
	var session bool
	for _, c := range w.Result().Cookies() {
		if c.Name == "kanban-token" && c.Value != "" {
			session = true
		}
	}
	if !session {
		t.Errorf("expected kanban-token cookie to be set, got %v", w.Result().Cookies())
	}
}
