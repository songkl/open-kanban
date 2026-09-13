package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// PendingOAuthState is one row of the pending_oauth_states table
// (migration 011, s-1145). It pairs the wire-level CSRF state the
// browser carries to the IdP with the PKCE verifier the callback
// handler will hand back to the IdP at the token-exchange step.
type PendingOAuthState struct {
	ID             string
	State          string
	ProviderID     string
	CodeVerifier   string
	CodeChallenge  string
	RedirectAfter  string
	CreatedAt      time.Time
	ExpiresAt      time.Time
	ConsumedAt     sql.NullTime
}

// PendingStateTTL is the lifetime of a freshly minted CSRF state
// per plan §7.1. Ten minutes is comfortably longer than the
// longest realistic IdP redirect round-trip (Google's 5-minute
// device-flow window doubled for headroom) but short enough that
// abandoned login clicks don't pile up.
const PendingStateTTL = 10 * time.Minute

// stateCookieName is the cookie name used for defence-in-depth
// state verification (plan §7.1 — the DB row is the source of
// truth, the cookie is a same-host sanity check so a state value
// minted for one origin can't be replayed against another).
const stateCookieName = "oauth_ext_state"

// stateBytes is the entropy used for the wire-level CSRF token.
// 32 bytes = 256 bits, base64url-encoded to 43 chars per RFC 7515
// §2 — same size as a high-entropy JWT secret and matches the
// "unpredictable opaque token" rule in OWASP's CSRF cheat sheet.
const stateBytes = 32

// pkceVerifierBytes is the entropy used for the PKCE verifier.
// RFC 7636 §4.1 mandates 43–128 chars from the unreserved set;
// 32 random bytes base64url-encoded gives exactly 43 chars, the
// minimum allowed, and is well above the ~128-bit strength the
// RFC requires.
const pkceVerifierBytes = 32

// ErrPendingStateNotFound is returned by ConsumePendingState
// when no row matches the supplied `state` value. The callback
// handler maps this to a 400 with a redacted message — leaking
// "row exists but expired" vs "no row at all" gives an attacker
// a free oracle for which state values were ever minted.
var ErrPendingStateNotFound = errors.New("oauth: pending state not found")

// ErrPendingStateExpired is returned when the row exists but
// the expires_at timestamp is in the past. The callback handler
// treats this the same as ErrPendingStateNotFound on the wire
// for the same oracle-leak reason.
var ErrPendingStateExpired = errors.New("oauth: pending state expired")

// ErrPendingStateConsumed is returned when the row was already
// consumed by an earlier callback. This is the one branch that
// signals "someone replayed this state" — the audit log records
// the IP / UA so an admin can spot a CSRF attempt.
var ErrPendingStateConsumed = errors.New("oauth: pending state already consumed")

// ErrPendingStateWrongProvider is returned by ConsumePendingState
// when the caller already narrowed the lookup to a specific
// provider and the matched row was minted for a different one.
// The callback handler always looks up by state alone (so any
// row matches); this error is reserved for the admin tooling.
var ErrPendingStateWrongProvider = errors.New("oauth: pending state bound to a different provider")

// generateOpaqueState returns 32 random bytes base64url-encoded
// (43 chars, no padding). Safe for the URL query string without
// further escaping — the base64url alphabet is URL-safe per
// RFC 7515 §2.
func generateOpaqueState() (string, error) {
	return encodeRandomBytes(stateBytes)
}

// generatePKCEPair returns a 43-char base64url verifier and its
// base64url(SHA-256) challenge. RFC 7636 §4.2 / §4.3.
func generatePKCEPair() (verifier, challenge string, err error) {
	verifier, err = encodeRandomBytes(pkceVerifierBytes)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// encodeRandomBytes is the shared helper for state and PKCE
// verifier generation. RawURLEncoding gives the URL-safe alphabet
// without padding so the value drops straight into a query string.
func encodeRandomBytes(n int) (string, error) {
	if n <= 0 {
		return "", errors.New("oauth: encodeRandomBytes: non-positive size")
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("oauth: read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// persistPendingState writes a freshly minted state row to the
// pending_oauth_states table. The expires_at argument is taken
// from the caller so the unit tests can pin a deterministic TTL.
func persistPendingState(db *sql.DB, providerID, state, verifier, challenge, redirectAfter string, expiresAt time.Time) error {
	if db == nil {
		return errors.New("oauth: persistPendingState: nil db")
	}
	if providerID == "" || state == "" || verifier == "" || challenge == "" {
		return errors.New("oauth: persistPendingState: missing required field")
	}
	if expiresAt.IsZero() {
		return errors.New("oauth: persistPendingState: zero expires_at")
	}
	id := generateOpaqueID()
	_, err := db.Exec(
		`INSERT INTO pending_oauth_states (
			id, state, provider_id, code_verifier, code_challenge,
			redirect_after, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, state, providerID, verifier, challenge, redirectAfter, expiresAt.UTC(),
	)
	return err
}

// ConsumePendingState looks up a state row, refuses if missing,
// expired, or already consumed, and stamps consumed_at on success.
// Returns the row's PK + PKCE verifier so the caller can drive
// the token exchange.
//
// The optional expectedProviderID is a defence-in-depth check
// used by the admin tooling; the callback handler passes ""
// because the URL slug has already resolved to a specific
// provider row.
func ConsumePendingState(ctx context.Context, db *sql.DB, state, expectedProviderID string) (*PendingOAuthState, error) {
	if strings.TrimSpace(state) == "" {
		return nil, ErrPendingStateNotFound
	}
	row := db.QueryRowContext(ctx,
		`SELECT id, state, provider_id, code_verifier, code_challenge,
		        redirect_after, created_at, expires_at, consumed_at
		   FROM pending_oauth_states
		  WHERE state = ?`,
		state,
	)
	var p PendingOAuthState
	if err := row.Scan(
		&p.ID, &p.State, &p.ProviderID, &p.CodeVerifier, &p.CodeChallenge,
		&p.RedirectAfter, &p.CreatedAt, &p.ExpiresAt, &p.ConsumedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPendingStateNotFound
		}
		return nil, fmt.Errorf("oauth: scan pending state: %w", err)
	}
	if p.ConsumedAt.Valid {
		return &p, ErrPendingStateConsumed
	}
	now := time.Now()
	if !p.ExpiresAt.IsZero() && now.After(p.ExpiresAt) {
		return &p, ErrPendingStateExpired
	}
	if expectedProviderID != "" && p.ProviderID != expectedProviderID {
		return &p, ErrPendingStateWrongProvider
	}

	// Atomic mark-consumed. Returning ErrNoRows here means a
	// concurrent callback already consumed the row between our
	// SELECT and UPDATE — treat as "already consumed" so the
	// caller surfaces the same audit-log row.
	res, err := db.ExecContext(ctx,
		`UPDATE pending_oauth_states
		    SET consumed_at = ?
		  WHERE id = ? AND consumed_at IS NULL`,
		now.UTC(), p.ID,
	)
	if err != nil {
		return &p, fmt.Errorf("oauth: mark state consumed: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return &p, fmt.Errorf("oauth: rows affected: %w", err)
	}
	if n == 0 {
		return &p, ErrPendingStateConsumed
	}
	p.ConsumedAt = sql.NullTime{Time: now.UTC(), Valid: true}
	return &p, nil
}

// PurgeExpiredPendingStates deletes rows whose expires_at is
// strictly before the supplied cutoff. Returns the number of rows
// removed so a future cron entry can log the count. Exposed
// separately from the test seam so an admin endpoint or scheduled
// job can call it without touching the gin handler.
func PurgeExpiredPendingStates(db *sql.DB, now time.Time) (int64, error) {
	if db == nil {
		return 0, errors.New("oauth: PurgeExpiredPendingStates: nil db")
	}
	if now.IsZero() {
		now = time.Now()
	}
	res, err := db.Exec(
		`DELETE FROM pending_oauth_states WHERE expires_at < ?`,
		now.UTC(),
	)
	if err != nil {
		return 0, fmt.Errorf("oauth: purge expired states: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
}

// sanitizeRedirectAfter enforces the open-redirect guard from
// plan §7.5: only relative paths starting with "/" and not
// containing "//" (which a browser would interpret as a scheme-
// relative URL pointing off-host) are accepted. Anything else
// is reduced to "" so the callback handler lands the user on
// the SPA root instead of a phishing page.
func sanitizeRedirectAfter(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.HasPrefix(raw, "/") {
		return ""
	}
	if strings.HasPrefix(raw, "//") {
		return ""
	}
	if strings.HasPrefix(raw, "/\\") {
		return ""
	}
	if len(raw) > 2048 {
		return ""
	}
	return raw
}

// ===================== HTTP login redirect handler =====================

// ExternalLoginHandler returns the gin handler for
// GET /oauth/external/:slug/login. The handler:
//   1. Resolves the slug → provider row (404 if disabled).
//   2. Mints a fresh state + PKCE pair and writes the row to
//      pending_oauth_states with a PendingStateTTL window.
//   3. Sets a defence-in-depth HttpOnly cookie carrying the
//      same state value (the callback handler will compare
//      cookie vs DB row — a cookie that mismatches the DB row
//      suggests the state was stolen off-host and replayed).
//   4. Builds the IdP authorize URL with response_type=code,
//      scope, redirect_uri back to /oauth/external/:slug/callback,
//      state, code_challenge, and code_challenge_method=S256.
//   5. Returns 302 to the IdP.
//
// The handler is publicly reachable (no RequireAuth) — the whole
// point of /login is to start an unauthenticated session.
//
// Optional `?redirect=<path>` query parameter lets the SPA deep-
// link the user to a specific board / task after a successful
// callback. The value is sanitized through sanitizeRedirectAfter
// so an attacker can't bounce the user to a phishing page.
func ExternalLoginHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		slug := strings.TrimSpace(c.Param("slug"))
		provider, err := FetchProviderBySlug(db, slug)
		if err != nil {
			if errors.Is(err, ErrProviderNotFound) || errors.Is(err, ErrProviderDisabled) {
				c.JSON(http.StatusNotFound, gin.H{"error": "provider not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		state, err := generateOpaqueState()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mint CSRF state"})
			return
		}
		verifier, challenge, err := generatePKCEPair()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mint PKCE pair"})
			return
		}

		redirectAfter := sanitizeRedirectAfter(c.Query("redirect"))
		expiresAt := time.Now().Add(PendingStateTTL)
		if err := persistPendingState(db, provider.ID, state, verifier, challenge, redirectAfter, expiresAt); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to persist CSRF state"})
			return
		}

		isSecure := c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https"
		c.SetSameSite(http.SameSiteLaxMode)
		c.SetCookie(stateCookieName, state, int(PendingStateTTL.Seconds()), "/", "", isSecure, true)

		authorizeURL, err := buildAuthorizeURL(c, provider, state, challenge)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Redirect(http.StatusFound, authorizeURL)
	}
}

// buildAuthorizeURL assembles the IdP authorize URL. The redirect
// URI is the callback URL on this server, derived from the
// incoming request so a reverse-proxy deployment doesn't need to
// configure the public origin per-provider.
//
// Per plan §7.2 the code_challenge_method is always S256 (SHA-256
// base64url) — the only method SupportedCodeChallengeMethods
// advertises, and the strongest method RFC 7636 defines. We do
// not expose a `require_pkce=false` opt-out in v1.
func buildAuthorizeURL(c *gin.Context, provider *AdminOAuthProvider, state, challenge string) (string, error) {
	authURL := strings.TrimSpace(provider.AuthEndpoint)
	if authURL == "" {
		return "", fmt.Errorf("provider %q has no auth_endpoint configured", provider.ProviderID)
	}
	parsed, err := url.Parse(authURL)
	if err != nil {
		return "", fmt.Errorf("provider %q auth_endpoint is not a valid URL: %w", provider.ProviderID, err)
	}
	q := parsed.Query()
	q.Set("response_type", "code")
	q.Set("client_id", provider.ClientID)
	q.Set("redirect_uri", externalRedirectURI(c, provider))
	if scope := strings.TrimSpace(provider.Scopes); scope != "" {
		q.Set("scope", scope)
	}
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	parsed.RawQuery = q.Encode()
	return parsed.String(), nil
}

// externalRedirectURI returns the absolute URL of this server's
// callback endpoint for the given provider. Built from the
// incoming request so reverse-proxy deployments get the public
// origin automatically (DiscoveryIssuerFromRequest does the same
// for /oauth/* discovery docs).
func externalRedirectURI(c *gin.Context, provider *AdminOAuthProvider) string {
	issuer := DiscoveryIssuerFromRequest(c)
	return issuer + "/oauth/external/" + url.PathEscape(provider.ProviderID) + "/callback"
}

// ExternalLoginHandlerForTest is the seam the external_state_test.go
// suite uses to mount the route. Production code MUST call
// ExternalLoginHandler so the same handler signature is used.
func ExternalLoginHandlerForTest(db *sql.DB) gin.HandlerFunc {
	return ExternalLoginHandler(db)
}

// GenerateOpaqueStateForTest exposes the internal state generator
// to the test suite. Production code MUST NOT call this — the
// only intended caller is the login handler, which generates a
// fresh value per request.
func GenerateOpaqueStateForTest() (string, error) {
	return generateOpaqueState()
}

// GeneratePKCEPairForTest exposes the internal PKCE generator to
// the test suite. Same "production MUST NOT call" rule.
func GeneratePKCEPairForTest() (string, string, error) {
	return generatePKCEPair()
}

// PersistPendingStateForTest exposes the internal row writer to
// the test suite so unit tests can seed expired / consumed rows
// without going through the login handler.
func PersistPendingStateForTest(db *sql.DB, providerID, state, verifier, challenge, redirectAfter string, expiresAt time.Time) error {
	return persistPendingState(db, providerID, state, verifier, challenge, redirectAfter, expiresAt)
}

// SanitizeRedirectAfterForTest exposes the open-redirect guard
// to the test suite. The redirect-parameter rules are part of
// plan §7.5 and the test pins every documented edge case.
func SanitizeRedirectAfterForTest(raw string) string {
	return sanitizeRedirectAfter(raw)
}

// PurgeExpiredPendingStatesForTest exposes the housekeeping
// helper so the test suite can pin the cut-off semantics.
func PurgeExpiredPendingStatesForTest(db *sql.DB, now time.Time) (int64, error) {
	return PurgeExpiredPendingStates(db, now)
}
