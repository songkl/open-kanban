package oauth

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AuthContextKey is the gin.Context key under which the validated bearer
// claims are stored. Use GetClaims(c) to retrieve them.
const (
	AuthContextKey  = "oauth_claims"
	ScopeContextKey = "oauth_scopes"
)

// ErrInsufficientScope is returned by RequireBearerToken when claims do not
// carry all the scopes required by the route.
var ErrInsufficientScope = errors.New("oauth: insufficient scope")

// RequireBearerToken returns a middleware that validates the Authorization
// Bearer header against the configured signer and enforces the provided scope
// requirements. On success it stores the *AccessTokenClaims under
// AuthContextKey and the parsed ScopeSet under ScopeContextKey.
//
// On failure the response carries an RFC 6750 WWW-Authenticate header so that
// MCP clients (or any RFC 6750 aware client) can self-discover the
// authorization server via /.well-known/oauth-authorization-server.
func RequireBearerToken(signer *Signer, requiredScopes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		issuer := DiscoveryIssuerFromRequest(c)
		audience := GetConfiguredAudience(c)

		header := c.GetHeader("Authorization")
		if header == "" {
			respondUnauthorized(c, issuer, "missing Authorization header")
			return
		}
		if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
			respondUnauthorized(c, issuer, "Authorization scheme must be Bearer")
			return
		}
		token := strings.TrimSpace(header[len("Bearer "):])
		if token == "" {
			respondUnauthorized(c, issuer, "empty bearer token")
			return
		}

		claims, err := signer.VerifyAccessToken(token, issuer, audience)
		if err != nil {
			respondUnauthorized(c, issuer, err.Error())
			return
		}

		scopes := ParseScopes(claims.Scope)
		if len(requiredScopes) > 0 && !scopes.HasAll(requiredScopes) {
			respondForbidden(c, issuer, scopes, requiredScopes)
			return
		}

		c.Set(AuthContextKey, claims)
		c.Set(ScopeContextKey, scopes)
		c.Next()
	}
}

// GetClaims returns the *AccessTokenClaims stored on the gin.Context by
// RequireBearerToken, or nil if the request was not authenticated via OAuth.
func GetClaims(c *gin.Context) *AccessTokenClaims {
	v, ok := c.Get(AuthContextKey)
	if !ok {
		return nil
	}
	if claims, ok := v.(*AccessTokenClaims); ok {
		return claims
	}
	return nil
}

// GetScopes returns the parsed ScopeSet stored by RequireBearerToken.
func GetScopes(c *gin.Context) ScopeSet {
	v, ok := c.Get(ScopeContextKey)
	if !ok {
		return ScopeSet{}
	}
	if s, ok := v.(ScopeSet); ok {
		return s
	}
	return ScopeSet{}
}

// respondUnauthorized emits a 401 with WWW-Authenticate pointing at the
// authorization server. The error_description carries a hint useful for
// debugging but does not include sensitive details.
func respondUnauthorized(c *gin.Context, issuer, description string) {
	wwwAuth := fmt.Sprintf(
		`Bearer realm="kanban", authorization_uri="%s/oauth/authorize", resource_metadata="%s/.well-known/oauth-protected-resource/mcp"`,
		issuer, issuer,
	)
	if description != "" {
		wwwAuth += fmt.Sprintf(`, error_description="%s"`, sanitize(description))
	}
	c.Header("WWW-Authenticate", wwwAuth)
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"error":             "invalid_token",
		"error_description": description,
	})
}

// respondForbidden emits a 403 with RFC 6750 §3 insufficient_scope error.
func respondForbidden(c *gin.Context, issuer string, scopes ScopeSet, required []string) {
	missing := make([]string, 0, len(required))
	for _, r := range required {
		if !scopes.Has(r) {
			missing = append(missing, r)
		}
	}
	wwwAuth := fmt.Sprintf(
		`Bearer realm="kanban", error="insufficient_scope", scope="%s", authorization_uri="%s/oauth/authorize"`,
		strings.Join(missing, " "), issuer,
	)
	c.Header("WWW-Authenticate", wwwAuth)
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
		"error":             "insufficient_scope",
		"error_description": "Token does not contain required scope(s)",
		"required_scope":    missing,
	})
}

func sanitize(s string) string {
	// Defensive: prevent header injection via untrusted error descriptions.
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}
