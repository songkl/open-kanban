package oauth

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// SupportedGrantTypes is the canonical list of grant types the AS advertises.
// Order matters: device_code first because that is the primary flow for MCP
// agents in stdio mode.
var SupportedGrantTypes = []string{
	GrantTypeDeviceCode,
	GrantTypeRefresh,
	GrantTypeClientCreds,
	GrantTypeAuthCode,
}

// SupportedAuthMethods lists the token endpoint authentication methods.
var SupportedAuthMethods = []string{
	"none",             // public client (MCP)
	"client_secret_basic",
	"client_secret_post",
}

// SupportedResponseTypes for the authorization code flow.
var SupportedResponseTypes = []string{"code"}

// SupportedCodeChallengeMethods for PKCE.
var SupportedCodeChallengeMethods = []string{"S256"}

// DiscoveryIssuerFromRequest resolves the public issuer URL for the given
// request. It prefers X-Forwarded-* headers so a reverse proxy can override it.
func DiscoveryIssuerFromRequest(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		parts := strings.Split(proto, ",")
		scheme = strings.TrimSpace(parts[0])
	}
	host := c.Request.Host
	if fwd := c.GetHeader("X-Forwarded-Host"); fwd != "" {
		parts := strings.Split(fwd, ",")
		host = strings.TrimSpace(parts[0])
	}
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host
}

// DiscoveryMetadata is RFC 8414's authorization server metadata document.
type DiscoveryMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	IntrospectionEndpoint             string   `json:"introspection_endpoint,omitempty"`
	RevocationEndpoint                string   `json:"revocation_endpoint,omitempty"`
	JWKSURI                           string   `json:"jwks_uri"`
	RegistrationEndpoint              string   `json:"registration_endpoint,omitempty"`
	DeviceAuthorizationEndpoint       string   `json:"device_authorization_endpoint,omitempty"`
	GrantTypesSupported               []string `json:"grant_types_supported"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported,omitempty"`
	ScopesSupported                   []string `json:"scopes_supported"`
	AuthorizationResponseIssuedAtSupported bool `json:"authorization_response_issued_at_supported,omitempty"`
}

// ProtectedResourceMetadata is RFC 8707's resource server metadata.
type ProtectedResourceMetadata struct {
	Resource               string   `json:"resource"`
	AuthorizationServers   []string `json:"authorization_servers"`
	JWKSURI                string   `json:"jwks_uri,omitempty"`
	BearerMethodsSupported []string `json:"bearer_methods_supported"`
	ResourceSigningAlgValuesSupported []string `json:"resource_signing_alg_values_supported,omitempty"`
	ResourceDocumentation  string   `json:"resource_documentation,omitempty"`
}

// DiscoveryHandler returns a gin handler that emits the OAuth authorization
// server metadata document at /.well-known/oauth-authorization-server.
func DiscoveryHandler(registerDevicePath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		issuer := DiscoveryIssuerFromRequest(c)
		audience := GetConfiguredAudience(c)
		md := DiscoveryMetadata{
			Issuer:                                issuer,
			AuthorizationEndpoint:                 issuer + "/oauth/authorize",
			TokenEndpoint:                         issuer + "/oauth/token",
			IntrospectionEndpoint:                 issuer + "/oauth/introspect",
			RevocationEndpoint:                    issuer + "/oauth/revoke",
			JWKSURI:                               issuer + "/.well-known/jwks.json",
			RegistrationEndpoint:                  issuer + "/oauth/register",
			DeviceAuthorizationEndpoint:           issuer + registerDevicePath,
			GrantTypesSupported:                   SupportedGrantTypes,
			ResponseTypesSupported:                SupportedResponseTypes,
			TokenEndpointAuthMethodsSupported:     SupportedAuthMethods,
			CodeChallengeMethodsSupported:         SupportedCodeChallengeMethods,
			ScopesSupported:                       SupportedScopes(),
			AuthorizationResponseIssuedAtSupported: true,
		}
		c.Header("Cache-Control", "public, max-age=300")
		_ = audience // currently unused at AS layer; left for future use.
		c.JSON(http.StatusOK, md)
	}
}

// ProtectedResourceHandler returns a gin handler for
// /.well-known/oauth-protected-resource/mcp (RFC 8707).
func ProtectedResourceHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		issuer := DiscoveryIssuerFromRequest(c)
		md := ProtectedResourceMetadata{
			Resource:                               issuer + "/api/v1",
			AuthorizationServers:                   []string{issuer},
			JWKSURI:                                issuer + "/.well-known/jwks.json",
			BearerMethodsSupported:                 []string{"header"},
			ResourceSigningAlgValuesSupported:      []string{"RS256"},
			ResourceDocumentation:                  issuer + "/docs/api",
		}
		c.Header("Cache-Control", "public, max-age=300")
		c.JSON(http.StatusOK, md)
	}
}

// JWKSHandler emits the JWKS document for /.well-known/jwks.json. The signer
// is loaded lazily on first request so a missing app_config row does not break
// server startup.
func JWKSHandler(signer *Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		if signer == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "oauth signing key not configured"})
			return
		}
		jwks, err := signer.JWKS()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to build JWKS"})
			return
		}
		c.Header("Cache-Control", "public, max-age=300")
		c.JSON(http.StatusOK, jwks)
	}
}

// GetConfiguredAudience is a stub for the configured audience claim. Today it
// always returns "kanban" but is exposed so settings can override later.
func GetConfiguredAudience(c *gin.Context) string {
	return "kanban"
}

// audienceForDB returns the configured audience from the app_config table.
// When no override is set it returns "kanban".
func audienceForDB(db *sql.DB) string {
	if db == nil {
		return "kanban"
	}
	var val string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'oauth_audience'").Scan(&val); err != nil || val == "" {
		return "kanban"
	}
	return val
}

// issuerForDB returns the configured issuer override from app_config. If no
// override is set the function returns "" and the caller should derive issuer
// from the HTTP request.
func issuerForDB(db *sql.DB) string {
	if db == nil {
		return ""
	}
	var val string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'oauth_issuer_override'").Scan(&val); err != nil {
		return ""
	}
	return val
}