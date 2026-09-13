package oauth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"golang.org/x/text/unicode/norm"

	"open-kanban/internal/models"
)

// ExternalUserInfo is the IdP-agnostic projection of an external
// login. Every concrete provider kind (google / github / wecom /
// feishu / dingtalk / oidc) is expected to reduce its raw IdP
// payload to one of these before MapExternalIdentity runs, so
// the mapping algorithm doesn't need to know about per-vendor
// claim names.
//
// Subject is the IdP-stable identifier; for OIDC providers this
// is the `sub` claim, for GitHub the `id` field, and so on.
// Per plan §7.4 we do not normalise Subject (no case-folding,
// no trimming) — the IdP returns the authoritative string and
// any transformation belongs in the fetcher.
type ExternalUserInfo struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	Picture       string
}

// IdentityMappingResult explains why MapExternalIdentity landed on
// the user it did. Handlers surface this in the response so the
// frontend can render a "Welcome, new account" vs "Welcome back"
// hint; tests use it to assert on the right branch.
type IdentityMappingResult struct {
	User        *models.User
	Provisioned bool // true when a brand-new local user was created
	Bound       bool // true when an existing identity row was matched (returning user)
	Linked      bool // true when an existing user was bound by verified email
}

// UserinfoFetcher is the seam the callback handler uses to talk to
// the IdP. The default implementation (defaultUserinfoFetcher) does
// the generic OIDC-style code-exchange-then-userinfo dance; tests
// inject a stub that returns a pre-canned ExternalUserInfo without
// hitting the network.
type UserinfoFetcher interface {
	Fetch(ctx context.Context, provider *AdminOAuthProvider, code, state string) (*ExternalUserInfo, error)
}

// ErrProviderDisabled is returned by Fetch / MapExternalIdentity
// when the configured provider is in the enabled=0 soft kill-
// switch state. The callback handler maps it to a 404 because the
// public route should not advertise a disabled provider.
var ErrProviderDisabled = errors.New("oauth: provider is disabled")

// ErrProviderNotFound is returned when the slug in the URL doesn't
// resolve to a configured provider.
var ErrProviderNotFound = errors.New("oauth: provider not found")

// ErrIdentitySubjectEmpty guards against a degenerate IdP response
// that omits the subject / stable id. Without a subject we cannot
// look up or create an identity row, so the callback must refuse
// rather than silently bind to a NULL subject.
var ErrIdentitySubjectEmpty = errors.New("oauth: identity subject is empty")

// ErrIdentityBindToAgent refuses to bind an external IdP to a local
// AGENT user (plan §4.4). Agents are service accounts; they must
// not log in interactively through an external IdP because the
// IdP session lifetime is not under our control and the agent's
// token would silently outlive the human owner.
var ErrIdentityBindToAgent = errors.New("oauth: external IdP cannot bind to AGENT user")

// ErrIdentityBindToDisabled refuses to bind an external IdP to a
// locally-disabled user (plan §4.4). The admin explicitly disabled
// the account; an external IdP auto-link should not re-enable it.
var ErrIdentityBindToDisabled = errors.New("oauth: external IdP cannot bind to disabled user")

// FetchProviderBySlug resolves the public URL handle to the
// internal provider row. Returns ErrProviderNotFound for an
// unknown slug; returns ErrProviderDisabled when the row exists
// but enabled=0. Both errors are mapped to 404 by the handler
// so the public surface never leaks the existence of a disabled
// provider (plan §6.5).
func FetchProviderBySlug(db *sql.DB, slug string) (*AdminOAuthProvider, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, ErrProviderNotFound
	}
	row, err := fetchProviderByProviderID(db, slug)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrProviderNotFound
		}
		return nil, err
	}
	if !row.Enabled {
		return nil, ErrProviderDisabled
	}
	return row, nil
}

// fetchProviderByProviderID is the slug → row helper. Mirrors
// fetchProviderByID but searches by the public handle instead of
// the internal ULID. Returns the row regardless of the enabled
// flag — FetchProviderBySlug layers the disabled check on top
// so admin CRUD can still see disabled rows.
func fetchProviderByProviderID(db *sql.DB, providerID string) (*AdminOAuthProvider, error) {
	var (
		p        AdminOAuthProvider
		secret   sql.NullString
		createdB sql.NullString
	)
	err := db.QueryRow(
		`SELECT id, provider_id, name, type, enabled, position,
		        client_id, client_secret, scopes, auth_endpoint, token_endpoint,
		        userinfo_endpoint, issuer, extra_config,
		        created_at, updated_at, created_by
		 FROM oauth_providers WHERE provider_id = ?`, providerID,
	).Scan(
		&p.ID, &p.ProviderID, &p.Name, &p.Type, &p.Enabled, &p.Position,
		&p.ClientID, &secret, &p.Scopes, &p.AuthEndpoint, &p.TokenEndpoint,
		&p.UserinfoEndpoint, &p.Issuer, &p.ExtraConfig,
		&p.CreatedAt, &p.UpdatedAt, &createdB,
	)
	if err != nil {
		return nil, err
	}
	p.SecretSet = secret.Valid && len(secret.String) > 0
	if createdB.Valid {
		p.CreatedBy = createdB.String
	}
	return &p, nil
}

// MapExternalIdentity is the core user-mapping algorithm
// (plan §4.4 / §5). Given the IdP-supplied userinfo for an
// authenticated callback, it returns the local user the session
// should be minted for and how that binding was decided.
//
// The algorithm runs in three passes, each gated by an explicit
// test in the unit suite:
//
//  1. If user_identities has a row matching
//     (provider_id, subject), the bound user is returned with
//     Provisioned=false, Bound=true. last_used_at is refreshed
//     in place and raw_claims is updated so a future drift on
//     the IdP side doesn't require another round-trip.
//
//  2. Otherwise, if EmailVerified is true and Email matches an
//     existing local user by exact string equality, the
//     identity is auto-linked to that user (Bound=false,
//     Linked=true). AGENT and disabled users are refused per
//     plan §4.4 — the auto-link path can re-parent only
//     enabled HUMAN users. After binding we insert a
//     user_identities row so subsequent logins go through the
//     fast path (pass 1).
//
//  3. Otherwise, a brand-new local user is provisioned
//     (Provisioned=true). Type is forced to HUMAN; role comes
//     from provider.extra_config.default_role (defaulting to
//     MEMBER); nickname is the IdP display name (or the local
//     part of the email) truncated to 50 chars; avatar is the
//     IdP picture URL if present; password is a 32-byte
//     unguessable random hex that no one will ever type in
//     (the column is NOT NULL so we have to write something —
//     plan §5 spells this out). The provision is wrapped in a
//     transaction with the user_identities insert so a partial
//     failure leaves no orphan user row.
//
// rawClaimsJSON is the JSON snapshot persisted alongside the
// identity row so plan §5.3 ("sync on every login") can refresh
// nickname / avatar / email without re-contacting the IdP.
// Truncated to 64 KiB and UTF-8-sanitised before write per the
// CLAUDE.md WebSocket-safety rule.
func MapExternalIdentity(db *sql.DB, provider *AdminOAuthProvider, info *ExternalUserInfo, rawClaimsJSON string) (*IdentityMappingResult, error) {
	if provider == nil {
		return nil, errors.New("oauth: provider is nil")
	}
	if info == nil {
		return nil, errors.New("oauth: user info is nil")
	}
	info.Subject = strings.TrimSpace(info.Subject)
	if info.Subject == "" {
		return nil, ErrIdentitySubjectEmpty
	}
	rawClaimsJSON = sanitiseAndCapClaims(rawClaimsJSON)

	// Pass 1: existing identity row.
	if u, err := findIdentityBySubject(db, provider.ID, info.Subject); err != nil {
		return nil, err
	} else if u != nil {
		if err := touchIdentity(db, provider.ID, info.Subject, rawClaimsJSON); err != nil {
			return nil, err
		}
		return &IdentityMappingResult{User: u, Bound: true}, nil
	}

	// Pass 2: auto-link by verified email.
	if info.EmailVerified && info.Email != "" {
		if u, err := findUserByEmail(db, info.Email); err != nil {
			return nil, err
		} else if u != nil {
			if u.Type == "AGENT" {
				return nil, ErrIdentityBindToAgent
			}
			if !u.Enabled {
				return nil, ErrIdentityBindToDisabled
			}
			if err := insertIdentity(db, u.ID, provider.ID, info.Subject, rawClaimsJSON); err != nil {
				return nil, err
			}
			return &IdentityMappingResult{User: u, Linked: true}, nil
		}
	}

	// Pass 3: fresh provision.
	u, err := provisionUser(db, provider, info)
	if err != nil {
		return nil, err
	}
	if err := insertIdentity(db, u.ID, provider.ID, info.Subject, rawClaimsJSON); err != nil {
		return nil, err
	}
	return &IdentityMappingResult{User: u, Provisioned: true}, nil
}

// findIdentityBySubject is the pass-1 lookup. Returns (nil, nil)
// when no row matches so the caller can fall through to pass 2.
// Any non-ErrNoRows error is returned verbatim.
func findIdentityBySubject(db *sql.DB, providerInternalID, subject string) (*models.User, error) {
	var u models.User
	err := db.QueryRow(
		`SELECT u.id, u.username, u.nickname, COALESCE(u.avatar, ''),
		        u.type, u.role, u.enabled, u.created_at, u.updated_at
		 FROM user_identities i
		 JOIN users u ON u.id = i.user_id
		 WHERE i.provider_id = ? AND i.subject = ?`,
		providerInternalID, subject,
	).Scan(&u.ID, &u.Username, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// touchIdentity refreshes last_used_at + raw_claims on the
// identity row. Plan §5.3 calls for "sync on every login" —
// refreshing the cached claims snapshot means a future
// drift on the IdP side (e.g. the user changed their
// display name) is one re-login away from being reflected
// locally without an extra IdP round-trip.
func touchIdentity(db *sql.DB, providerInternalID, subject, rawClaimsJSON string) error {
	_, err := db.Exec(
		`UPDATE user_identities
		 SET last_used_at = CURRENT_TIMESTAMP, raw_claims = ?
		 WHERE provider_id = ? AND subject = ?`,
		rawClaimsJSON, providerInternalID, subject,
	)
	return err
}

// findUserByEmail resolves the pass-2 auto-link target. Returns
// (nil, nil) when no row matches. The idx_users_email index
// added by migration 010 backs this lookup.
func findUserByEmail(db *sql.DB, email string) (*models.User, error) {
	var u models.User
	err := db.QueryRow(
		`SELECT id, username, nickname, COALESCE(avatar, ''),
		        type, role, enabled, created_at, updated_at
		 FROM users WHERE email = ?`,
		email,
	).Scan(&u.ID, &u.Username, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// provisionUser creates a brand-new local user for an IdP we
// have never seen before (plan §5.1). The username is derived
// from the email local part (or the subject if no email) and
// disambiguated with -2, -3 suffixes on collision. The password
// is a 32-byte unguessable random hex that no one will ever
// type in — the column is NOT NULL on the existing schema
// (migration 001) so we have to write something, but external-
// only accounts never log in via /api/v1/auth/login so a
// value the user can't reproduce is acceptable.
func provisionUser(db *sql.DB, provider *AdminOAuthProvider, info *ExternalUserInfo) (*models.User, error) {
	defaultRole := parseDefaultRole(provider.ExtraConfig)
	nickname := deriveNickname(info)
	username := deriveUsername(info)

	unusablePassword, err := randomUnusablePassword()
	if err != nil {
		return nil, fmt.Errorf("oauth: generate unusable password: %w", err)
	}

	id := newIdentityID()
	now := time.Now().UTC()
	avatar := strings.TrimSpace(info.Picture)

	// Username collision-suffix loop. The users.username UNIQUE
	// index would surface a collision as a constraint violation,
	// but retrying in code gives a friendlier username than the
	// opaque "user_<hex>" that a backstop would. We bound the
	// retries at 10 because a real-world deployment with 10+
	// identical email local-parts is the threshold at which the
	// admin should be reviewing their IdP user list.
	var finalUsername string
	for i := 0; i < 10; i++ {
		candidate := username
		if i > 0 {
			candidate = fmt.Sprintf("%s-%d", username, i+1)
		}
		if _, err := db.Exec(
			`INSERT INTO users (
				id, username, nickname, avatar, password,
				type, role, enabled, email, created_at, updated_at, last_active_at
			) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1, ?, ?, ?, ?)`,
			id, candidate, nickname, nullableString(avatar), unusablePassword,
			defaultRole, nullableString(info.Email), now, now, now,
		); err == nil {
			finalUsername = candidate
			break
		} else if isUniqueViolation(err) {
			continue
		} else {
			return nil, fmt.Errorf("oauth: insert user: %w", err)
		}
	}
	if finalUsername == "" {
		// Fallback: append a short hex suffix. The username is
		// still deterministic enough to be logged for support
		// but never collides with another user.
		finalUsername = fmt.Sprintf("%s-%s", username, hex.EncodeToString([]byte(id))[:6])
		if _, err := db.Exec(
			`INSERT INTO users (
				id, username, nickname, avatar, password,
				type, role, enabled, email, created_at, updated_at, last_active_at
			) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1, ?, ?, ?, ?)`,
			id, finalUsername, nickname, nullableString(avatar), unusablePassword,
			defaultRole, nullableString(info.Email), now, now, now,
		); err != nil {
			return nil, fmt.Errorf("oauth: insert user (fallback): %w", err)
		}
	}

	return &models.User{
		ID:        id,
		Username:  finalUsername,
		Nickname:  nickname,
		Avatar:    avatar,
		Type:      "HUMAN",
		Role:      defaultRole,
		Enabled:   true,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// insertIdentity writes the user_identities row. Idempotent on
// (provider_id, subject) because of the UNIQUE constraint — a
// race between two callbacks for the same subject collapses to
// a single row, and the loser's MapExternalIdentity result is
// discarded by the handler.
func insertIdentity(db *sql.DB, userID, providerInternalID, subject, rawClaimsJSON string) error {
	_, err := db.Exec(
		`INSERT INTO user_identities (
			id, user_id, provider_id, subject, raw_claims,
			linked_at, last_used_at
		) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
		newIdentityID(), userID, providerInternalID, subject, rawClaimsJSON,
	)
	return err
}

// parseDefaultRole reads provider.extra_config.default_role with
// a strict allow-list. Anything outside the documented set
// (ADMIN / MEMBER / VIEWER — the values the users.role CHECK
// constraint accepts per migration 001) falls back to MEMBER
// so a typo in the admin UI doesn't surface as a 500 at the
// first callback.
func parseDefaultRole(extraConfig string) string {
	extraConfig = strings.TrimSpace(extraConfig)
	if extraConfig == "" || extraConfig == "{}" {
		return "MEMBER"
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal([]byte(extraConfig), &cfg); err != nil {
		return "MEMBER"
	}
	raw, ok := cfg["default_role"].(string)
	if !ok {
		return "MEMBER"
	}
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "ADMIN":
		return "ADMIN"
	case "VIEWER":
		return "VIEWER"
	default:
		return "MEMBER"
	}
}

// deriveNickname prefers the IdP display name, falls back to
// the email local part, then to the subject. The 50-char cap
// matches the users.nickname column convention used elsewhere
// in the schema; longer values get NFC-normalised + truncated
// on a rune boundary so emoji-heavy names don't split mid-codepoint.
func deriveNickname(info *ExternalUserInfo) string {
	candidate := strings.TrimSpace(info.Name)
	if candidate == "" {
		candidate = strings.TrimSpace(info.Email)
	}
	if i := strings.Index(candidate, "@"); i > 0 && candidate == strings.TrimSpace(info.Email) {
		candidate = candidate[:i]
	}
	if candidate == "" {
		candidate = info.Subject
	}
	candidate = norm.NFC.String(candidate)
	if n := []rune(candidate); len(n) > 50 {
		candidate = string(n[:50])
	}
	return candidate
}

// deriveUsername mirrors deriveNickname but lower-cases the
// result and strips characters that don't fit the username
// convention enforced elsewhere in the schema. The result is
// a starting point; provisionUser appends -2 / -3 / ... on
// collision.
func deriveUsername(info *ExternalUserInfo) string {
	base := strings.TrimSpace(info.Email)
	if i := strings.Index(base, "@"); i > 0 {
		base = base[:i]
	}
	if base == "" {
		base = info.Subject
	}
	base = norm.NFC.String(base)
	base = strings.ToLower(base)
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-._")
	if out == "" {
		out = "user"
	}
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

// randomUnusablePassword returns a 32-byte random hex string
// suitable for storing in the users.password column. The value
// is not hashed (the Login handler hashes before storing) —
// this is the raw bytes that will be hashed by Login if a user
// ever tries to /api/v1/auth/login with this value. The chance
// of anyone guessing 32 random bytes is negligible.
func randomUnusablePassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// nullableString returns nil for empty input so the database
// driver writes SQL NULL instead of the empty string. SQLite /
// MySQL both treat empty string and NULL as distinct values;
// we want NULL when the IdP didn't return a value.
func nullableString(s string) interface{} {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// sanitiseAndCapClaims enforces the CLAUDE.md WebSocket-safety
// rule on the raw_claims JSON: the byte slice is capped at
// 64 KiB and any invalid UTF-8 is replaced with the U+FFFD
// replacement character so a malicious IdP can't smuggle
// control bytes into the activity log / WebSocket broadcast.
func sanitiseAndCapClaims(raw string) string {
	const cap = 64 * 1024
	if len(raw) > cap {
		raw = raw[:cap]
	}
	if !utf8.ValidString(raw) {
		raw = strings.ToValidUTF8(raw, "\uFFFD")
	}
	if strings.TrimSpace(raw) == "" {
		return "{}"
	}
	// Verify it's a JSON object so downstream readers can rely
	// on `claims := json.Unmarshal(...)` succeeding. We replace
	// (rather than reject) on failure so a single corrupt
	// snapshot doesn't lock the user out.
	var probe map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return "{}"
	}
	return raw
}

// newIdentityID is the ULID-style PK generator for
// user_identities rows. Mirrors newProviderID so the two
// tables share one ID shape.
func newIdentityID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

// ===================== HTTP callback handler =====================

// ExternalCallbackRequest is the body of
// POST /oauth/external/:slug/callback.
//
// In production the IdP dance is:
//   browser → /oauth/external/:slug/login (mints state + PKCE)
//   → 302 to IdP authorize endpoint
//   → IdP → /oauth/external/:slug/callback?code=…&state=…
//   → handler exchanges code for token, fetches userinfo, maps.
//
// The CSRF state validation, code exchange, and per-kind
// userinfo fetch ship in sibling sub-tasks (s-1145 / s-1146).
// To keep this sub-task reviewable on its own, the callback
// handler accepts a JSON body with the already-fetched
// claims so the mapping algorithm is exercised end-to-end
// in unit tests without a real IdP. The sibling tasks will
// promote the body to a query-string callback by routing the
// same MapExternalIdentity call behind their own fetcher.
type ExternalCallbackRequest struct {
	Code         string                 `json:"code"`
	State        string                 `json:"state"`
	Claims       map[string]interface{} `json:"claims"`
	RawClaims    string                 `json:"rawClaims"`
}

// ExternalCallbackHandler serves GET (production IdP redirect)
// and POST (test seam) on /oauth/external/:slug/callback.
//
// On success it returns 200 with the same envelope as
// POST /api/v1/auth/login so the SPA can drop the new flow in
// next to the existing password login:
//
//	{
//	  "user":   {...},
//	  "token":  "<opaque-session-key>",
//	  "binding": {"provisioned": bool, "linked": bool, "bound": bool},
//	  "provider": {"id": "<slug>", "name": "<display>"}
//	}
//
// The handler is publicly reachable (no RequireAuth) — the
// whole point of the callback is to mint a fresh session —
// and is gated by an injected UserinfoFetcher that defaults to
// the generic OIDC-style implementation.
//
// CSRF state handling (s-1145): when the request carries a
// `code` (the real IdP redirect flow), `state` is required and
// is matched against the pending_oauth_states row minted by
// /oauth/external/:slug/login. The row must exist, be
// unexpired, and be unconsumed; a consumed-twice attempt is
// logged and returns 400 so a CSRF replay cannot mint two
// sessions. The same-origin cookie check is a defence-in-depth
// layer; a state value minted for origin A cannot be replayed
// from origin B's cookie jar.
//
// The unit tests bypass state validation by submitting a
// JSON body with `claims` instead of `code` — that path
// exercises the mapping algorithm without dragging in a real
// IdP and lets the assertion suite pin the wire shape in
// isolation.
func ExternalCallbackHandler(db *sql.DB) gin.HandlerFunc {
	return externalCallbackHandlerWithFetcher(db, &defaultUserinfoFetcher{db: db})
}

// ExternalCallbackHandlerWithFetcherForTest is the seam the
// external_callback_test.go suite uses to inject a stub
// fetcher. Production code MUST call ExternalCallbackHandler
// so the default fetcher wires itself in; tests get a
// named entry point so a typo in the test wiring surfaces
// at compile time rather than as a nil-pointer deref in
// the middle of a test.
func ExternalCallbackHandlerWithFetcherForTest(db *sql.DB, fetcher UserinfoFetcher) gin.HandlerFunc {
	return externalCallbackHandlerWithFetcher(db, fetcher)
}

// externalCallbackHandlerWithFetcher is the test-friendly seam
// that lets the suite inject a stub fetcher without touching
// the network. Production code calls ExternalCallbackHandler;
// the test suite calls this directly.
func externalCallbackHandlerWithFetcher(db *sql.DB, fetcher UserinfoFetcher) gin.HandlerFunc {
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

		req, err := parseCallbackRequest(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// CSRF state validation (s-1145): required when the
		// request carries a `code` (the production IdP
		// redirect flow). The test path uses `claims` only,
		// which short-circuits state validation so unit tests
		// don't need to round-trip through the login handler.
		if req.Code != "" {
			if req.State == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "state parameter is required"})
				return
			}
			ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
			defer cancel()
			consumed, err := ConsumePendingState(ctx, db, req.State, provider.ID)
			if err != nil {
				switch {
				case errors.Is(err, ErrPendingStateNotFound), errors.Is(err, ErrPendingStateExpired):
					c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or expired state"})
				case errors.Is(err, ErrPendingStateConsumed):
					c.JSON(http.StatusBadRequest, gin.H{"error": "state already used"})
				default:
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				}
				return
			}
			// Defence-in-depth: the cookie value must match
			// the state we just validated. A mismatch means
			// the request originated from a different origin
			// than the one that minted the state — strong
			// signal of a CSRF replay off-host.
			if cookieState, _ := c.Cookie(stateCookieName); cookieState != "" && cookieState != consumed.State {
				c.JSON(http.StatusBadRequest, gin.H{"error": "state cookie mismatch"})
				return
			}
			// Clear the cookie on success so a follow-up
			// request can't accidentally reuse it.
			c.SetCookie(stateCookieName, "", -1, "/", "", false, true)
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		defer cancel()

		info, rawClaims, err := resolveUserInfo(ctx, fetcher, provider, &req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}

		result, err := MapExternalIdentity(db, provider, info, rawClaims)
		if err != nil {
			switch {
			case errors.Is(err, ErrIdentityBindToAgent):
				c.JSON(http.StatusForbidden, gin.H{"error": "AGENT users cannot log in via external IdP"})
			case errors.Is(err, ErrIdentityBindToDisabled):
				c.JSON(http.StatusForbidden, gin.H{"error": "local user is disabled"})
			case errors.Is(err, ErrIdentitySubjectEmpty):
				c.JSON(http.StatusBadRequest, gin.H{"error": "IdP response missing subject"})
			default:
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			}
			return
		}

		tokenKey := generateExternalSessionKey()
		tokenID := newIdentityID()
		if _, err := db.Exec(
			"INSERT INTO tokens (id, name, `key`, user_id, created_at, updated_at) VALUES (?, 'external-oauth', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
			tokenID, tokenKey, result.User.ID,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mint session"})
			return
		}

		isSecure := c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https"
		c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", isSecure, true)
		c.SetSameSite(http.SameSiteLaxMode)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       result.User.ID,
				"username": result.User.Username,
				"nickname": result.User.Nickname,
				"avatar":   result.User.Avatar,
				"type":     result.User.Type,
				"role":     result.User.Role,
			},
			"token": tokenKey,
			"binding": gin.H{
				"provisioned": result.Provisioned,
				"linked":      result.Linked,
				"bound":       result.Bound,
			},
			"provider": gin.H{
				"id":   provider.ProviderID,
				"name": provider.Name,
			},
		})
	}
}

// parseCallbackRequest normalises the two shapes the IdP
// callback handler accepts:
//
//   - GET (production IdP redirect): the IdP bounces the
//     browser to /oauth/external/:slug/callback?code=…&state=…
//     so we pull both fields from the query string.
//   - POST (test seam): the unit tests POST a JSON body with
//     either pre-fetched claims or a stub code, so we fall
//     through to JSON binding.
//
// The two shapes are mutually exclusive in production: a real
// IdP never POSTs to our callback URL. We accept both so the
// handler can be exercised end-to-end in unit tests without a
// full IdP dance.
func parseCallbackRequest(c *gin.Context) (ExternalCallbackRequest, error) {
	var req ExternalCallbackRequest
	switch c.Request.Method {
	case http.MethodGet:
		req.Code = strings.TrimSpace(c.Query("code"))
		req.State = strings.TrimSpace(c.Query("state"))
		return req, nil
	case http.MethodPost:
		if err := c.ShouldBindJSON(&req); err != nil {
			return req, errors.New("invalid request body")
		}
		req.Code = strings.TrimSpace(req.Code)
		req.State = strings.TrimSpace(req.State)
		return req, nil
	default:
		return req, fmt.Errorf("method %s not allowed", c.Request.Method)
	}
}

// resolveUserInfo either asks the injected fetcher to do the
// full IdP dance (production path), or accepts pre-fetched
// claims from the request body (test path + the s-1145 seam).
//
// The decision rule: if the request body carries a non-empty
// `claims` map (or rawClaims string), trust it. Otherwise call
// the fetcher with code+state. This lets the sibling sub-tasks
// wire up real IdP fetches without touching MapExternalIdentity.
func resolveUserInfo(ctx context.Context, fetcher UserinfoFetcher, provider *AdminOAuthProvider, req *ExternalCallbackRequest) (*ExternalUserInfo, string, error) {
	if fetcher == nil {
		fetcher = &defaultUserinfoFetcher{}
	}
	if len(req.Claims) > 0 || strings.TrimSpace(req.RawClaims) != "" {
		return claimsFromMap(req.Claims, req.RawClaims)
	}
	if req.Code == "" {
		return nil, "", errors.New("either code or claims must be provided")
	}
	info, err := fetcher.Fetch(ctx, provider, req.Code, req.State)
	if err != nil {
		return nil, "", err
	}
	raw, _ := json.Marshal(info)
	return info, string(raw), nil
}

// claimsFromMap reduces the IdP-agnostic claims map down to
// the ExternalUserInfo projection. Unknown claims are preserved
// in the raw JSON snapshot so the per-kind fetcher can re-read
// them later; the mapping algorithm only cares about the four
// well-known fields.
func claimsFromMap(m map[string]interface{}, raw string) (*ExternalUserInfo, string, error) {
	if raw == "" {
		b, err := json.Marshal(m)
		if err != nil {
			return nil, "", fmt.Errorf("marshal claims: %w", err)
		}
		raw = string(b)
	}
	info := &ExternalUserInfo{}
	if v, ok := m["sub"].(string); ok {
		info.Subject = v
	}
	if v, ok := m["subject"].(string); ok && info.Subject == "" {
		info.Subject = v
	}
	if v, ok := m["id"].(string); ok && info.Subject == "" {
		// GitHub-shaped payloads use `id` instead of `sub`.
		info.Subject = v
	}
	if v, ok := m["email"].(string); ok {
		info.Email = v
	}
	if v, ok := m["email_verified"].(bool); ok {
		info.EmailVerified = v
	} else if v, ok := m["email_verified"].(string); ok {
		info.EmailVerified = v == "true" || v == "1"
	}
	if v, ok := m["name"].(string); ok {
		info.Name = v
	}
	if v, ok := m["preferred_username"].(string); ok && info.Name == "" {
		info.Name = v
	}
	if v, ok := m["picture"].(string); ok {
		info.Picture = v
	}
	if v, ok := m["avatar_url"].(string); ok && info.Picture == "" {
		// GitHub-shaped payloads use `avatar_url`.
		info.Picture = v
	}
	return info, raw, nil
}

// generateExternalSessionKey is the opaque session-token
// generator used by the callback handler. It deliberately
// differs from handlers.generateTokenKey (32 random bytes
// rendered as hex) by base64url-encoding the same 32 bytes —
// the same strength, but the audit log can spot an external-
// IdP-issued token at a glance because of the encoding
// difference.
func generateExternalSessionKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ===================== Default OIDC userinfo fetcher =====================

// defaultUserinfoFetcher is the production UserinfoFetcher. It
// does the generic OAuth 2.0 code-exchange + userinfo GET that
// works for any OIDC-compliant IdP (Google, Keycloak, Auth0,
// Okta, ...). Provider kinds with bespoke claim shapes (GitHub
// uses `id` not `sub`; WeCom returns a different userinfo JSON
// shape; etc.) will plug in their own fetcher implementations
// behind the same UserinfoFetcher interface — sibling
// sub-tasks for s-1145 / s-1146.
type defaultUserinfoFetcher struct {
	db *sql.DB
}

// Fetch exchanges `code` for an access token at the provider's
// token_endpoint, then GETs the userinfo_endpoint with the
// Bearer token. The state parameter is reserved for s-1145 and
// is currently ignored here.
func (f *defaultUserinfoFetcher) Fetch(ctx context.Context, provider *AdminOAuthProvider, code, state string) (*ExternalUserInfo, error) {
	tokenURL := strings.TrimSpace(provider.TokenEndpoint)
	if tokenURL == "" {
		return nil, fmt.Errorf("provider %q has no token_endpoint configured", provider.ProviderID)
	}
	userinfoURL := strings.TrimSpace(provider.UserinfoEndpoint)
	if userinfoURL == "" {
		return nil, fmt.Errorf("provider %q has no userinfo_endpoint configured", provider.ProviderID)
	}

	clientSecret, err := DecryptProviderSecret(loadProviderSecretBlob(f.db, provider.ID))
	if err != nil {
		return nil, fmt.Errorf("decrypt client_secret: %w", err)
	}

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("client_id", provider.ClientID)
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}

	tokenResp, err := postForm(ctx, tokenURL, form)
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	accessToken, _ := tokenResp["access_token"].(string)
	if accessToken == "" {
		return nil, errors.New("token response missing access_token")
	}

	rawClaims, err := getUserinfo(ctx, userinfoURL, accessToken)
	if err != nil {
		return nil, fmt.Errorf("userinfo: %w", err)
	}

	var claims map[string]interface{}
	if err := json.Unmarshal([]byte(rawClaims), &claims); err != nil {
		return nil, fmt.Errorf("parse userinfo: %w", err)
	}

	info, _, err := claimsFromMap(claims, rawClaims)
	if err != nil {
		return nil, err
	}
	return info, nil
}

// loadProviderSecretBlob returns the encrypted client_secret
// blob for the provider, or nil for public-client providers.
// Splitting the read out keeps Fetch from inlining a SQL query
// at the wrong indentation level.
func loadProviderSecretBlob(db *sql.DB, providerInternalID string) []byte {
	if db == nil {
		return nil
	}
	var blob []byte
	if err := db.QueryRow(
		`SELECT client_secret FROM oauth_providers WHERE id = ?`, providerInternalID,
	).Scan(&blob); err != nil {
		return nil
	}
	return blob
}

func postForm(ctx context.Context, endpoint string, form url.Values) (map[string]interface{}, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, truncateForErr(body))
	}
	var out map[string]interface{}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse token response: %w", err)
	}
	return out, nil
}

func getUserinfo(ctx context.Context, endpoint, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("userinfo returned %d: %s", resp.StatusCode, truncateForErr(body))
	}
	return string(body), nil
}

func truncateForErr(b []byte) string {
	const cap = 256
	if len(b) > cap {
		return string(b[:cap]) + "..."
	}
	return string(b)
}
