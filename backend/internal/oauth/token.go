package oauth

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"open-kanban/internal/models"
)

// Token request forms. The endpoint accepts both form-encoded (default) and
// JSON bodies for symmetry with the rest of the API surface.
type TokenRequest struct {
	GrantType    string `json:"grant_type" form:"grant_type"`
	ClientID     string `json:"client_id" form:"client_id"`
	ClientSecret string `json:"client_secret" form:"client_secret"`
	Scope        string `json:"scope" form:"scope"`
	DeviceCode   string `json:"device_code" form:"device_code"`
	RefreshToken string `json:"refresh_token" form:"refresh_token"`
}

// TokenEndpoint returns the gin handler for POST /oauth/token. The signer
// parameter must be loaded via LoadOrGenerate before the server starts.
func TokenEndpoint(db *sql.DB, signer *Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req TokenRequest
		if err := c.ShouldBind(&req); err != nil {
			writeOAuthError(c, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}

		switch req.GrantType {
		case GrantTypeDeviceCode:
			handleDeviceCodeGrant(c, db, signer, &req)
		case GrantTypeRefresh:
			handleRefreshTokenGrant(c, db, signer, &req)
		case GrantTypeClientCreds:
			handleClientCredentialsGrant(c, db, signer, &req)
		case GrantTypeAuthCode:
			// Implemented in authcode.go; reply with proper error for now.
			writeOAuthError(c, http.StatusBadRequest, "unsupported_grant_type",
				"authorization_code grant not yet wired in this build")
		default:
			writeOAuthError(c, http.StatusBadRequest, "unsupported_grant_type",
				fmt.Sprintf("grant_type %q not supported", req.GrantType))
		}
	}
}

// writeOAuthError serialises an OAuth-style error and sets the Cache-Control
// header per RFC 6749 §5.1.
func writeOAuthError(c *gin.Context, status int, code, description string) {
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.JSON(status, models.OAuthErrorResponse{
		Error:            code,
		ErrorDescription: description,
	})
}

// authenticateClient resolves the client from the request body or Basic auth,
// then verifies the client_secret when the client is confidential.
func authenticateClient(c *gin.Context, db *sql.DB, req *TokenRequest) (*models.OAuthClient, error) {
	clientID := req.ClientID
	clientSecret := req.ClientSecret

	if id, secret, ok := c.Request.BasicAuth(); ok {
		if clientID == "" {
			clientID = id
		}
		if clientSecret == "" {
			clientSecret = secret
		}
	}

	if clientID == "" {
		return nil, errors.New("client_id is required")
	}
	client, err := GetClient(db, clientID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("invalid_client")
		}
		return nil, fmt.Errorf("lookup client: %w", err)
	}
	if client.ClientSecretHash != nil {
		if clientSecret == "" {
			return nil, errors.New("invalid_client: client_secret required")
		}
		if err := VerifyClientSecret(client, clientSecret); err != nil {
			return nil, errors.New("invalid_client: secret mismatch")
		}
	}
	return client, nil
}

// handleDeviceCodeGrant exchanges an approved device_code for an access token.
func handleDeviceCodeGrant(c *gin.Context, db *sql.DB, signer *Signer, req *TokenRequest) {
	client, err := authenticateClient(c, db, req)
	if err != nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", err.Error())
		return
	}
	if !ClientAllowsGrant(client, GrantTypeDeviceCode) {
		writeOAuthError(c, http.StatusBadRequest, "unauthorized_client",
			"client not allowed to use device_code grant")
		return
	}
	if req.DeviceCode == "" {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "device_code is required")
		return
	}

	dc, err := FindDeviceCodeByDeviceToken(db, req.DeviceCode)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "device_code not recognised")
			return
		}
		writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
		return
	}
	if dc.ClientID != client.ClientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "device_code was issued to a different client")
		return
	}

	// Polling discipline: enforce interval_seconds minimum (RFC 8628 §3.5).
	if dc.LastPollAt != nil {
		earliest := dc.LastPollAt.Add(time.Duration(dc.IntervalSeconds) * time.Second)
		if time.Now().Before(earliest) {
			c.Header("Retry-After", fmt.Sprintf("%d", dc.IntervalSeconds))
			writeOAuthError(c, http.StatusBadRequest, "slow_down",
				fmt.Sprintf("polling too frequently; interval is %d seconds", dc.IntervalSeconds))
			return
		}
	}
	_ = MarkDevicePolled(db, dc.ID)

	switch dc.Status {
	case "approved":
		// fall through
	case "pending":
		writeOAuthError(c, http.StatusBadRequest, "authorization_pending",
			"the user has not yet approved the request")
		return
	case "denied":
		writeOAuthError(c, http.StatusBadRequest, "access_denied",
			"the user denied the request")
		return
	case "expired":
		writeOAuthError(c, http.StatusBadRequest, "expired_token",
			"the device_code has expired")
		return
	default:
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant",
			fmt.Sprintf("unexpected device_code status %s", dc.Status))
		return
	}

	if time.Now().After(dc.ExpiresAt) {
		writeOAuthError(c, http.StatusBadRequest, "expired_token", "the device_code has expired")
		return
	}

	scope := dc.Scope
	if req.Scope != "" {
		// Optional narrowing (RFC 6749 §5.1).
		allowed := ParseScopes(dc.Scope)
		requested := ParseScopes(req.Scope)
		if !requested.IsSubsetOf(allowed) {
			writeOAuthError(c, http.StatusBadRequest, "invalid_scope",
				"requested scope exceeds original grant")
			return
		}
		scope = req.Scope
	}

	if !ClientAllowsScope(client, scope) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_scope",
			"requested scope exceeds client registration")
		return
	}

	if dc.UserID == nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error",
			"approved device code missing user binding")
		return
	}

	issueAccessAndRefresh(c, db, signer, client, *dc.UserID, scope, true)
}

// handleRefreshTokenGrant rotates a refresh token into a new access+refresh pair.
func handleRefreshTokenGrant(c *gin.Context, db *sql.DB, signer *Signer, req *TokenRequest) {
	client, err := authenticateClient(c, db, req)
	if err != nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", err.Error())
		return
	}
	if req.RefreshToken == "" {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "refresh_token is required")
		return
	}

	hash := HashToken(req.RefreshToken)
	row := db.QueryRow(
		`SELECT id, client_id, user_id, scope, expires_at, revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?`,
		hash,
	)
	var (
		id        string
		clientID  string
		userID    string
		scope     string
		expiresAt time.Time
		revokedAt sql.NullTime
	)
	if err := row.Scan(&id, &clientID, &userID, &scope, &expiresAt, &revokedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "refresh_token not recognised")
			return
		}
		writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
		return
	}
	if revokedAt.Valid {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "refresh_token has been revoked")
		return
	}
	if time.Now().After(expiresAt) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "refresh_token expired")
		return
	}
	if clientID != client.ClientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "refresh_token issued to a different client")
		return
	}

	// Rotate: revoke the old token and issue a new pair.
	if _, err := db.Exec("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE id = ?", time.Now(), id); err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
		return
	}

	finalScope := scope
	if req.Scope != "" {
		allowed := ParseScopes(scope)
		requested := ParseScopes(req.Scope)
		if !requested.IsSubsetOf(allowed) {
			writeOAuthError(c, http.StatusBadRequest, "invalid_scope",
				"requested scope exceeds original grant")
			return
		}
		finalScope = req.Scope
	}
	if !ClientAllowsScope(client, finalScope) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_scope",
			"requested scope exceeds client registration")
		return
	}

	issueAccessAndRefresh(c, db, signer, client, userID, finalScope, true)
}

// handleClientCredentialsGrant issues a service-account access token.
func handleClientCredentialsGrant(c *gin.Context, db *sql.DB, signer *Signer, req *TokenRequest) {
	client, err := authenticateClient(c, db, req)
	if err != nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", err.Error())
		return
	}
	if !ClientAllowsGrant(client, GrantTypeClientCreds) {
		writeOAuthError(c, http.StatusBadRequest, "unauthorized_client",
			"client not allowed to use client_credentials grant")
		return
	}
	if client.ClientSecretHash == nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client",
			"client_credentials requires a confidential client")
		return
	}

	scope := req.Scope
	if scope == "" {
		scope = strings.Join(client.Scopes, " ")
	}
	if !ClientAllowsScope(client, scope) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_scope",
			"requested scope exceeds client registration")
		return
	}

	// Service accounts bind sub to the client_id (no human user).
	issueAccessAndRefresh(c, db, signer, client, client.ClientID, scope, false)
}

// issueAccessAndRefresh mints an access token (and refresh token when
// includeRefresh is true) and writes the standard token response.
func issueAccessAndRefresh(c *gin.Context, db *sql.DB, signer *Signer, client *models.OAuthClient,
	subject, scope string, includeRefresh bool) {
	accessTTL := readIntConfig(db, "oauth_access_token_ttl_seconds", defaultAccessTokenTTLSeconds)
	refreshTTL := readIntConfig(db, "oauth_refresh_token_ttl_seconds", defaultRefreshTokenTTLSeconds)

	issuer := DiscoveryIssuerFromRequest(c)
	audience := GetConfiguredAudience(c)

	now := time.Now()
	claims := &AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   subject,
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(accessTTL) * time.Second)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
		},
		ClientID:  client.ClientID,
		Scope:     scope,
		TokenType: TokenTypeAccess,
		AuthTime:  now.Unix(),
	}
	access, err := signer.Sign(claims)
	if err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
		return
	}

	resp := models.OAuthTokenResponse{
		AccessToken: access,
		TokenType:   "Bearer",
		ExpiresIn:   int64(accessTTL),
		Scope:       scope,
	}

	if includeRefresh {
		plain, _, err := generateClientSecret() // reuse the random helper
		if err != nil {
			writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
			return
		}
		rowID := generateOpaqueID()
		expiresAt := now.Add(time.Duration(refreshTTL) * time.Second)
		_, err = db.Exec(
			`INSERT INTO oauth_refresh_tokens
				(id, token_hash, client_id, user_id, scope, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			rowID, HashToken(plain), client.ClientID, subject, scope, expiresAt, now,
		)
		if err != nil {
			writeOAuthError(c, http.StatusInternalServerError, "server_error", err.Error())
			return
		}
		resp.RefreshToken = plain
	}

	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.JSON(http.StatusOK, resp)
}
