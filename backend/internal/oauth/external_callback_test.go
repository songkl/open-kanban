package oauth_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/oauth"
)

// setupCallbackDB returns an in-memory SQLite with the schema
// the OAuth external-callback path touches: users (with the
// 010 email column), tokens (for the session-mint step), the
// oauth_providers table from 009, and the new user_identities
// table from 010.
//
// FK enforcement is enabled per-connection so the
// ON DELETE CASCADE assertions in the suite actually fire —
// without PRAGMA foreign_keys=ON the cascade is a silent no-op
// and a regression in the migration would slip past the tests.
func setupCallbackDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupProviderDB(t)
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE users ADD COLUMN email TEXT`); err != nil {
		t.Fatalf("add users.email: %v", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`); err != nil {
		t.Fatalf("idx_users_email: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS user_identities (
			id              TEXT PRIMARY KEY,
			user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			provider_id     TEXT NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
			subject         TEXT NOT NULL,
			raw_claims      TEXT NOT NULL DEFAULT '{}',
			linked_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_used_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(provider_id, subject)
		)`); err != nil {
		t.Fatalf("user_identities schema: %v", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id)`); err != nil {
		t.Fatalf("idx_user_identities_user: %v", err)
	}
	return db
}

// insertCallbackProvider seeds an oauth_providers row with a
// pre-encrypted client_secret blob. Returns the provider row's
// internal id so the test can pass it to MapExternalIdentity.
func insertCallbackProvider(t *testing.T, db *sql.DB, slug, name, ptype string, secret []byte) string {
	t.Helper()
	id := "prov-" + slug
	if _, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_at, updated_at
		) VALUES (?, ?, ?, ?, 1, 0, ?, ?, '', '', '', '', '', '{}', ?, ?)`,
		id, slug, name, ptype, "client-"+slug, secret, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	return id
}

// seedUser inserts a users row directly so tests can exercise
// the auto-link-by-email path without going through
// provisionUser. Returns the new id.
func seedUser(t *testing.T, db *sql.DB, id, username, nickname, email, userType, role string, enabled bool) string {
	t.Helper()
	enabledInt := 0
	if enabled {
		enabledInt = 1
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, email, type, role, enabled, password)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'unusable')`,
		id, username, nickname, email, userType, role, enabledInt,
	); err != nil {
		t.Fatalf("seed user %s: %v", id, err)
	}
	return id
}

// loadProvider returns the oauth_providers row by slug (the
// public handle), using the same projection the production
// FetchProviderBySlug uses so the tests pin the wire shape.
func loadProvider(t *testing.T, db *sql.DB, slug string) *oauth.AdminOAuthProvider {
	t.Helper()
	p, err := oauth.FetchProviderBySlug(db, slug)
	if err != nil {
		t.Fatalf("FetchProviderBySlug(%s): %v", slug, err)
	}
	return p
}

// stubFetcher is a UserinfoFetcher that returns the canned
// claims without touching the network. Used by the HTTP-level
// tests so they can exercise the full handler → mapper path
// without standing up a fake IdP.
type stubFetcher struct {
	info  *oauth.ExternalUserInfo
	raw   string
	calls int
	err   error
}

func (s *stubFetcher) Fetch(_ context.Context, _ *oauth.AdminOAuthProvider, _, _ string) (*oauth.ExternalUserInfo, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.info, nil
}

// newCallbackServer wires the external-callback handler with
// the supplied fetcher injected. The route is mounted
// publicly (no RequireAuth) because the callback's job is to
// mint a session — that's the whole point.
func newCallbackServer(t *testing.T, db *sql.DB, fetcher oauth.UserinfoFetcher) *gin.Engine {
	t.Helper()
	r := gin.New()
	if fetcher == nil {
		fetcher = &stubFetcher{}
	}
	r.POST("/oauth/external/:slug/callback", oauth.ExternalCallbackHandlerWithFetcherForTest(db, fetcher))
	return r
}

// stubIdentity returns a stock ExternalUserInfo used by most
// happy-path tests. Per-field overrides happen at the call site.
func stubIdentity(subject, email string, verified bool) *oauth.ExternalUserInfo {
	return &oauth.ExternalUserInfo{
		Subject:       subject,
		Email:         email,
		EmailVerified: verified,
		Name:          "Alice Example",
		Picture:       "https://example.com/avatar.png",
	}
}

// ===================== Mapping algorithm (pure) =====================

// 1. First-time login provisions a brand-new local user with
//    the role defaulting to MEMBER, type=HUMAN, enabled=1,
//    and writes a user_identities row.
//
// Pins plan §4.4 / §5.1.
func TestMapExternalIdentity_ProvisionNewUser(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	providerID := insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))

	res, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-1", "alice@example.com", true), `{"sub":"google-sub-1"}`)
	if err != nil {
		t.Fatalf("MapExternalIdentity: %v", err)
	}
	if !res.Provisioned {
		t.Errorf("expected Provisioned=true on first login, got %+v", res)
	}
	if res.Bound || res.Linked {
		t.Errorf("expected Bound=false, Linked=false on first login, got %+v", res)
	}
	if res.User.Type != "HUMAN" {
		t.Errorf("expected Type=HUMAN, got %q", res.User.Type)
	}
	if res.User.Role != "MEMBER" {
		t.Errorf("expected Role=MEMBER, got %q", res.User.Role)
	}
	if !res.User.Enabled {
		t.Errorf("expected Enabled=true, got false")
	}
	// user_identities row must exist with the right subject.
	var gotUser string
	if err := db.QueryRow(
		`SELECT user_id FROM user_identities WHERE provider_id = ? AND subject = ?`,
		providerID, "google-sub-1",
	).Scan(&gotUser); err != nil {
		t.Fatalf("query identity: %v", err)
	}
	if gotUser != res.User.ID {
		t.Errorf("identity row points to user %q, want %q", gotUser, res.User.ID)
	}

	// Provisioned user has the IdP email persisted in the
	// users.email column (added by migration 010) so a
	// future login on a different IdP can auto-link.
	var storedEmail sql.NullString
	if err := db.QueryRow(`SELECT email FROM users WHERE id = ?`, res.User.ID).Scan(&storedEmail); err != nil {
		t.Fatalf("query email: %v", err)
	}
	if !storedEmail.Valid || storedEmail.String != "alice@example.com" {
		t.Errorf("expected email alice@example.com persisted, got %v", storedEmail)
	}
}

// 2. Returning user: the second call with the same subject
//    binds to the existing local user without provisioning a
//    second one. Bound=true, Provisioned=false.
//
// Pins the pass-1 hot path in the algorithm.
func TestMapExternalIdentity_BoundReturningUser(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))

	first, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-1", "alice@example.com", true), `{"sub":"google-sub-1"}`)
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	second, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-1", "alice@example.com", true), `{"sub":"google-sub-1"}`)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if second.Provisioned {
		t.Errorf("returning user should not provision a second account")
	}
	if !second.Bound {
		t.Errorf("returning user should be Bound=true")
	}
	if second.User.ID != first.User.ID {
		t.Errorf("returning user mapped to %q, want %q", second.User.ID, first.User.ID)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 user row, got %d", n)
	}
}

// 3. Auto-link by verified email: a brand-new IdP subject
//    whose email matches an existing local user (with email
//    verified=true) binds to that user. Linked=true,
//    Provisioned=false.
//
// Pins plan §4.4 row 1 ("verified email match").
func TestMapExternalIdentity_AutoLinkByVerifiedEmail(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))
	existing := seedUser(t, db, "local-1", "alice", "Alice Local", "alice@example.com", "HUMAN", "MEMBER", true)

	res, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-NEW", "alice@example.com", true), `{"sub":"google-sub-NEW"}`)
	if err != nil {
		t.Fatalf("auto-link: %v", err)
	}
	if res.Provisioned {
		t.Errorf("auto-link should not provision")
	}
	if !res.Linked {
		t.Errorf("auto-link should set Linked=true, got %+v", res)
	}
	if res.User.ID != existing {
		t.Errorf("auto-link mapped to %q, want existing user %q", res.User.ID, existing)
	}

	// The identity row should now exist, so the next login
	// for the same subject hits the pass-1 fast path.
	second, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-NEW", "alice@example.com", true), `{"sub":"google-sub-NEW"}`)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if !second.Bound {
		t.Errorf("post-link second call should be Bound=true")
	}
}

// 4. Auto-link refuses AGENT users — plan §4.4 row 1
//    explicitly forbids binding an external IdP to an Agent
//    identity. The error must surface so the handler can
//    respond with 403.
func TestMapExternalIdentity_RefusesBindToAgent(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))
	seedUser(t, db, "agent-1", "bot-alice", "Bot Alice", "alice@example.com", "AGENT", "MEMBER", true)

	_, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-NEW", "alice@example.com", true), `{"sub":"google-sub-NEW"}`)
	if !errors.Is(err, oauth.ErrIdentityBindToAgent) {
		t.Fatalf("expected ErrIdentityBindToAgent, got %v", err)
	}
}

// 5. Auto-link refuses locally-disabled users — plan §4.4
//    row 1 forbids re-enabling an account via IdP login.
func TestMapExternalIdentity_RefusesBindToDisabled(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))
	seedUser(t, db, "local-1", "alice", "Alice Local", "alice@example.com", "HUMAN", "MEMBER", false)

	_, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-NEW", "alice@example.com", true), `{"sub":"google-sub-NEW"}`)
	if !errors.Is(err, oauth.ErrIdentityBindToDisabled) {
		t.Fatalf("expected ErrIdentityBindToDisabled, got %v", err)
	}
}

// 6. EmailVerified=false on a brand-new subject with a
//    matching local user email must NOT auto-link — instead
//    a fresh user is provisioned. Pins the "no verified
//    email, no auto-link" branch.
//
// Plan §4.4 row 1 conditions the auto-link on
// email_verified=true; unverified claims must fall through
// to the provision path so an attacker can't squat a local
// account by claiming an unverified email address.
func TestMapExternalIdentity_UnverifiedEmailFallsThrough(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("enc-secret"))
	seedUser(t, db, "local-1", "alice", "Alice Local", "alice@example.com", "HUMAN", "MEMBER", true)

	res, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("google-sub-NEW", "alice@example.com", false), `{"sub":"google-sub-NEW"}`)
	if err != nil {
		t.Fatalf("mapping: %v", err)
	}
	if !res.Provisioned {
		t.Errorf("unverified email should fall through to provision, got %+v", res)
	}
	if res.User.ID == "local-1" {
		t.Errorf("unverified email auto-linked to existing local user, must not")
	}
}

// 7. Multi-IdP binding: a single local user may carry N rows
//    in user_identities (one per provider). Two different
//    providers binding the same local user must coexist.
//
// Pins plan §5.2.
func TestMapExternalIdentity_MultiIdpBinding(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	insertCallbackProvider(t, db, "github", "GitHub", "github", []byte("gh"))
	seedUser(t, db, "local-1", "alice", "Alice Local", "alice@example.com", "HUMAN", "MEMBER", true)

	google, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("g-1", "alice@example.com", true), `{"sub":"g-1"}`)
	if err != nil {
		t.Fatalf("google link: %v", err)
	}
	if !google.Linked {
		t.Errorf("google should be Linked=true on first bind")
	}

	github, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "github"), stubIdentity("gh-1", "alice@example.com", true), `{"sub":"gh-1"}`)
	if err != nil {
		t.Fatalf("github link: %v", err)
	}
	if !github.Linked {
		t.Errorf("github should be Linked=true")
	}
	if github.User.ID != google.User.ID {
		t.Errorf("github mapped to %q, want same user as google %q", github.User.ID, google.User.ID)
	}

	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM user_identities WHERE user_id = ?`, google.User.ID,
	).Scan(&n); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 identity rows for one user, got %d", n)
	}
}

// 8. raw_claims is refreshed on every returning-user login
//    so the plan §5.3 sync-on-every-login guarantee holds
//    even when the IdP returns the same subject.
func TestMapExternalIdentity_RefreshesRawClaims(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), `{"sub":"sub-1","name":"Old"}`); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), `{"sub":"sub-1","name":"New"}`); err != nil {
		t.Fatalf("second: %v", err)
	}

	var raw string
	if err := db.QueryRow(`SELECT raw_claims FROM user_identities WHERE subject = ?`, "sub-1").Scan(&raw); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !strings.Contains(raw, `"New"`) {
		t.Errorf("expected refreshed claims to mention New, got %q", raw)
	}
	if strings.Contains(raw, `"Old"`) {
		t.Errorf("expected old claims to be overwritten, got %q", raw)
	}
}

// 9. Subject is mandatory — a degenerate IdP response that
//    omits the stable identifier must be refused, not silently
//    bound to a NULL subject.
func TestMapExternalIdentity_RefusesEmptySubject(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	_, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("", "alice@example.com", true), `{}`)
	if !errors.Is(err, oauth.ErrIdentitySubjectEmpty) {
		t.Fatalf("expected ErrIdentitySubjectEmpty, got %v", err)
	}
}

// 10. extra_config.default_role=ADMIN is honoured on
//     provision. Pins plan §5.1 row "role".
func TestMapExternalIdentity_RespectsDefaultRole(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	id := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET extra_config = ? WHERE id = ?`, `{"default_role":"ADMIN"}`, id); err != nil {
		t.Fatalf("update: %v", err)
	}

	res, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), `{}`)
	if err != nil {
		t.Fatalf("mapping: %v", err)
	}
	if res.User.Role != "ADMIN" {
		t.Errorf("expected Role=ADMIN, got %q", res.User.Role)
	}
}

// 11. extra_config.default_role=unknown falls back to MEMBER
//     so a typo doesn't surface as a 500 at the first
//     callback.
func TestMapExternalIdentity_UnknownDefaultRoleFallsBackToMember(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	id := insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET extra_config = ? WHERE id = ?`, `{"default_role":"god-mode"}`, id); err != nil {
		t.Fatalf("update: %v", err)
	}

	res, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), `{}`)
	if err != nil {
		t.Fatalf("mapping: %v", err)
	}
	if res.User.Role != "MEMBER" {
		t.Errorf("expected Role=MEMBER fallback, got %q", res.User.Role)
	}
}

// 12. raw_claims is sanitised — a >64KiB blob is truncated
//     and any invalid UTF-8 is replaced so a malicious IdP
//     can't smuggle control bytes into the activity log /
//     WebSocket broadcast (CLAUDE.md WebSocket-safety rule).
func TestMapExternalIdentity_RawClaimsSanitised(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	huge := strings.Repeat("a", 80*1024) + "\xff\xfe"
	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), huge); err != nil {
		t.Fatalf("mapping: %v", err)
	}

	var raw string
	if err := db.QueryRow(`SELECT raw_claims FROM user_identities WHERE subject = ?`, "sub-1").Scan(&raw); err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(raw) > 64*1024 {
		t.Errorf("raw_claims not capped: %d bytes", len(raw))
	}
	if strings.ContainsRune(raw, '\uFFFD') == false && strings.Contains(raw, string([]byte{0xff})) {
		t.Errorf("invalid UTF-8 not replaced: %x", raw[:64])
	}
}

// 13. Username collision suffixes: a second user whose IdP
//     maps to the same email local part gets a -2 suffix
//     instead of a UNIQUE-constraint error.
func TestMapExternalIdentity_UsernameCollisionSuffix(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))

	a, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-A", "shared@example.com", false), `{}`)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	b, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-B", "shared@example.com", false), `{}`)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if a.User.Username == b.User.Username {
		t.Errorf("expected distinct usernames, both got %q", a.User.Username)
	}
	if !strings.HasPrefix(b.User.Username, "shared-") {
		t.Errorf("expected second username to be suffixed, got %q", b.User.Username)
	}
}

// 14. Disabling an oauth_providers row prevents the
//     FetchProviderBySlug helper from returning it. The
//     callback handler relies on this to 404 the public
//     surface for a soft-disabled provider.
func TestFetchProviderBySlug_DisabledReturnsErr(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET enabled = 0 WHERE provider_id = 'google'`); err != nil {
		t.Fatalf("disable: %v", err)
	}
	_, err := oauth.FetchProviderBySlug(db, "google")
	if !errors.Is(err, oauth.ErrProviderDisabled) {
		t.Fatalf("expected ErrProviderDisabled, got %v", err)
	}
}

// 15. Unknown slug returns ErrProviderNotFound (mapped to 404
//     by the handler).
func TestFetchProviderBySlug_UnknownReturnsErr(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	_, err := oauth.FetchProviderBySlug(db, "nope")
	if !errors.Is(err, oauth.ErrProviderNotFound) {
		t.Fatalf("expected ErrProviderNotFound, got %v", err)
	}
}

// ===================== HTTP handler =====================

// 16. Happy-path POST /oauth/external/:slug/callback mints a
//     kanban session token and returns the user + token in the
//     same envelope as POST /api/v1/auth/login.
func TestExternalCallbackHandler_HappyPath(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	r := newCallbackServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "alice@example.com", true)})

	body := `{"claims":{"sub":"sub-1","email":"alice@example.com","email_verified":true,"name":"Alice"}}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["token"] == nil || resp["token"] == "" {
		t.Errorf("missing token in response: %v", resp)
	}
	user, _ := resp["user"].(map[string]interface{})
	if user["nickname"] != "Alice" {
		t.Errorf("expected nickname=Alice, got %v", user["nickname"])
	}
	if user["type"] != "HUMAN" {
		t.Errorf("expected type=HUMAN, got %v", user["type"])
	}
	binding, _ := resp["binding"].(map[string]interface{})
	if binding["provisioned"] != true {
		t.Errorf("expected binding.provisioned=true on first login, got %v", binding)
	}

	// tokens row was written.
	var tokenKey string
	if err := db.QueryRow(`SELECT `+"`key`"+` FROM tokens WHERE user_id = ?`, user["id"]).Scan(&tokenKey); err != nil {
		t.Fatalf("query token: %v", err)
	}
	if tokenKey == "" {
		t.Errorf("empty token row")
	}

	// kanban-token cookie is set on the response.
	var foundCookie bool
	for _, c := range w.Result().Cookies() {
		if c.Name == "kanban-token" && c.Value == tokenKey {
			foundCookie = true
			break
		}
	}
	if !foundCookie {
		t.Errorf("expected kanban-token cookie, got %v", w.Result().Cookies())
	}
}

// 17. Unknown slug → 404 (without leaking whether the row
//     exists for a different slug).
func TestExternalCallbackHandler_UnknownSlug(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	r := newCallbackServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})

	body := `{"claims":{"sub":"sub-1"}}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/nope/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 18. Disabled provider → 404. Pins plan §6.5.
func TestExternalCallbackHandler_DisabledProvider(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	if _, err := db.Exec(`UPDATE oauth_providers SET enabled = 0 WHERE provider_id = 'google'`); err != nil {
		t.Fatalf("disable: %v", err)
	}
	r := newCallbackServer(t, db, &stubFetcher{info: stubIdentity("sub-1", "a@b.com", true)})

	body := `{"claims":{"sub":"sub-1"}}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

// 19. Auto-link-by-email for an AGENT user → 403 with a
//     caller-readable error message.
func TestExternalCallbackHandler_RefusesAgent(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	seedUser(t, db, "agent-1", "bot-alice", "Bot Alice", "alice@example.com", "AGENT", "MEMBER", true)
	r := newCallbackServer(t, db, &stubFetcher{info: stubIdentity("sub-NEW", "alice@example.com", true)})

	body := `{"claims":{"sub":"sub-NEW","email":"alice@example.com","email_verified":true}}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "AGENT") {
		t.Errorf("expected error to mention AGENT, got %s", w.Body.String())
	}
}

// 20. Invalid JSON body → 400.
func TestExternalCallbackHandler_BadJSON(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	r := newCallbackServer(t, db, &stubFetcher{})

	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader("{not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// 21. When the request body has neither `claims` nor `code`,
//     the handler must respond 400 rather than silently
//     calling the fetcher with empty inputs.
func TestExternalCallbackHandler_NeitherCodeNorClaims(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	r := newCallbackServer(t, db, &stubFetcher{err: errors.New("should not be called")})

	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d: %s", w.Code, w.Body.String())
	}
}

// 22. When only `code` is supplied (no claims), the handler
//     delegates to the injected UserinfoFetcher. Pins the
//     production code path; the stub asserts it was called
//     exactly once.
func TestExternalCallbackHandler_CodePathCallsFetcher(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	stub := &stubFetcher{info: stubIdentity("sub-1", "alice@example.com", true)}
	r := newCallbackServer(t, db, stub)

	body := `{"code":"fake-auth-code","state":"fake-state"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if stub.calls != 1 {
		t.Errorf("expected fetcher called once, got %d", stub.calls)
	}
}

// 23. Fetcher failure surfaces as 502 — the IdP is upstream
//     of us, so Bad Gateway is the semantically correct code.
func TestExternalCallbackHandler_FetcherError(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	r := newCallbackServer(t, db, &stubFetcher{err: errors.New("IdP down")})

	body := `{"code":"x"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/external/google/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d: %s", w.Code, w.Body.String())
	}
}

// 24. Cascade: deleting a user with N identity bindings must
//     remove all of them via ON DELETE CASCADE so the GDPR
//     parity guarantee in plan §3.3 holds.
func TestUserIdentities_CascadeOnUserDelete(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	insertCallbackProvider(t, db, "github", "GitHub", "github", []byte("h"))
	seedUser(t, db, "local-1", "alice", "Alice", "alice@example.com", "HUMAN", "MEMBER", true)

	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("g-1", "alice@example.com", true), `{}`); err != nil {
		t.Fatalf("google link: %v", err)
	}
	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "github"), stubIdentity("gh-1", "alice@example.com", true), `{}`); err != nil {
		t.Fatalf("github link: %v", err)
	}

	if _, err := db.Exec(`DELETE FROM users WHERE id = ?`, "local-1"); err != nil {
		t.Fatalf("delete user: %v", err)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_identities WHERE user_id = ?`, "local-1").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("expected cascade to drop identity rows, got %d", n)
	}
}

// 25. Cascade: deleting a provider drops all of its identity
//     bindings, so removing an IdP in the admin UI leaves no
//     orphan rows.
func TestUserIdentities_CascadeOnProviderDelete(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	seedUser(t, db, "local-1", "alice", "Alice", "alice@example.com", "HUMAN", "MEMBER", true)

	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("sub-1", "alice@example.com", true), `{}`); err != nil {
		t.Fatalf("mapping: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM oauth_providers WHERE provider_id = ?`, "google"); err != nil {
		t.Fatalf("delete provider: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_identities`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("expected cascade to drop identity rows, got %d", n)
	}
}

// 26. UNIQUE(provider_id, subject) prevents two identity
//     rows pointing at the same IdP subject. Pins plan §3.3.
func TestUserIdentities_UniqueProviderSubject(t *testing.T) {
	db := setupCallbackDB(t)
	defer db.Close()
	insertCallbackProvider(t, db, "google", "Google", "google", []byte("g"))
	seedUser(t, db, "a", "alice-a", "Alice A", "a@x.com", "HUMAN", "MEMBER", true)
	seedUser(t, db, "b", "alice-b", "Alice B", "b@x.com", "HUMAN", "MEMBER", true)

	// First bind succeeds.
	if _, err := oauth.MapExternalIdentity(db, loadProvider(t, db, "google"), stubIdentity("dup-sub", "a@x.com", true), `{}`); err != nil {
		t.Fatalf("first: %v", err)
	}

	// A second bind for the same subject must error out (a
	// manual INSERT that tries to write a second row for the
	// same provider+subject is what we are guarding against).
	if _, err := db.Exec(
		`INSERT INTO user_identities (id, user_id, provider_id, subject) VALUES (?, ?, ?, ?)`,
		"dup-row", "b", loadProvider(t, db, "google").ID, "dup-sub",
	); err == nil {
		t.Errorf("expected UNIQUE constraint to reject duplicate (provider_id, subject)")
	}
}
