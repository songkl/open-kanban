package oauth_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/oauth"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func newDiscoveryServer(t *testing.T, devicePath string) (*gin.Engine, *oauth.Signer) {
	t.Helper()
	signer, db := seedSigner(t)
	t.Cleanup(func() { _ = db.Close() })
	r := gin.New()
	r.GET("/.well-known/oauth-authorization-server", oauth.DiscoveryHandler(devicePath))
	r.GET("/.well-known/oauth-protected-resource/mcp", oauth.ProtectedResourceHandler())
	r.GET("/.well-known/jwks.json", oauth.JWKSHandler(signer))
	return r, signer
}

func TestDiscoveryHandlerReturnsExpectedMetadata(t *testing.T) {
	r, _ := newDiscoveryServer(t, "/oauth/device/code")

	req := httptest.NewRequest(http.MethodGet, "/.well-known/oauth-authorization-server", nil)
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc == "" {
		t.Error("expected Cache-Control header")
	}

	var md oauth.DiscoveryMetadata
	if err := json.Unmarshal(w.Body.Bytes(), &md); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if md.Issuer != "http://kanban.example" {
		t.Errorf("expected issuer http://kanban.example, got %s", md.Issuer)
	}
	if md.AuthorizationEndpoint != "http://kanban.example/oauth/authorize" {
		t.Errorf("authorization_endpoint mismatch: %s", md.AuthorizationEndpoint)
	}
	if md.TokenEndpoint != "http://kanban.example/oauth/token" {
		t.Errorf("token_endpoint mismatch: %s", md.TokenEndpoint)
	}
	if md.JWKSURI != "http://kanban.example/.well-known/jwks.json" {
		t.Errorf("jwks_uri mismatch: %s", md.JWKSURI)
	}
	if md.RegistrationEndpoint != "http://kanban.example/oauth/register" {
		t.Errorf("registration_endpoint mismatch: %s", md.RegistrationEndpoint)
	}
	if md.DeviceAuthorizationEndpoint != "http://kanban.example/oauth/device/code" {
		t.Errorf("device_authorization_endpoint mismatch: %s", md.DeviceAuthorizationEndpoint)
	}
	if md.IntrospectionEndpoint != "http://kanban.example/oauth/introspect" {
		t.Errorf("introspection_endpoint mismatch: %s", md.IntrospectionEndpoint)
	}
	if md.RevocationEndpoint != "http://kanban.example/oauth/revoke" {
		t.Errorf("revocation_endpoint mismatch: %s", md.RevocationEndpoint)
	}
	mustContain(t, md.GrantTypesSupported, "urn:ietf:params:oauth:grant-type:device_code")
	mustContain(t, md.GrantTypesSupported, "refresh_token")
	mustContain(t, md.GrantTypesSupported, "client_credentials")
	mustContain(t, md.GrantTypesSupported, "authorization_code")
	mustContain(t, md.ResponseTypesSupported, "code")
	mustContain(t, md.TokenEndpointAuthMethodsSupported, "none")
	mustContain(t, md.TokenEndpointAuthMethodsSupported, "client_secret_basic")
	mustContain(t, md.CodeChallengeMethodsSupported, "S256")
	if len(md.ScopesSupported) == 0 {
		t.Error("expected non-empty scopes_supported")
	}
}

func TestDiscoveryHandlerHonoursForwardedHeaders(t *testing.T) {
	r, _ := newDiscoveryServer(t, "/oauth/device/code")

	req := httptest.NewRequest(http.MethodGet, "/.well-known/oauth-authorization-server", nil)
	req.Host = "internal.local"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "kanban.example, extra.example")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var md oauth.DiscoveryMetadata
	if err := json.Unmarshal(w.Body.Bytes(), &md); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !strings.HasPrefix(md.Issuer, "https://kanban.example") {
		t.Errorf("expected issuer to start with https://kanban.example, got %s", md.Issuer)
	}
	if md.JWKSURI != "https://kanban.example/.well-known/jwks.json" {
		t.Errorf("expected jwks_uri to reflect forward host, got %s", md.JWKSURI)
	}
}

func TestProtectedResourceHandlerReturnsResourceMetadata(t *testing.T) {
	r, _ := newDiscoveryServer(t, "/oauth/device/code")

	req := httptest.NewRequest(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", nil)
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var md oauth.ProtectedResourceMetadata
	if err := json.Unmarshal(w.Body.Bytes(), &md); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if md.Resource != "http://kanban.example/api/v1" {
		t.Errorf("expected resource http://kanban.example/api/v1, got %s", md.Resource)
	}
	if len(md.AuthorizationServers) != 1 || md.AuthorizationServers[0] != "http://kanban.example" {
		t.Errorf("authorization_servers mismatch: %v", md.AuthorizationServers)
	}
	if md.JWKSURI != "http://kanban.example/.well-known/jwks.json" {
		t.Errorf("jwks_uri mismatch: %s", md.JWKSURI)
	}
	if len(md.BearerMethodsSupported) == 0 {
		t.Error("expected bearer_methods_supported to be non-empty")
	}
}

func TestJWKSHandlerReturnsKeySet(t *testing.T) {
	r, signer := newDiscoveryServer(t, "/oauth/device/code")

	req := httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var jwks oauth.JWKS
	if err := json.Unmarshal(w.Body.Bytes(), &jwks); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(jwks.Keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(jwks.Keys))
	}
	k := jwks.Keys[0]
	if k.Kty != "RSA" || k.Alg != "RS256" || k.Kid == "" {
		t.Errorf("invalid jwk shape: %+v", k)
	}
	// The kid must match the signer's kid
	signJWK, err := signer.PublicJWK()
	if err != nil {
		t.Fatalf("signer.JWKS: %v", err)
	}
	if signJWK.Kid != k.Kid {
		t.Errorf("kid mismatch: signer=%s handler=%s", signJWK.Kid, k.Kid)
	}
}

func TestJWKSHandlerReturns503WhenSignerNil(t *testing.T) {
	r := gin.New()
	r.GET("/.well-known/jwks.json", oauth.JWKSHandler(nil))

	req := httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func mustContain(t *testing.T, list []string, want string) {
	t.Helper()
	for _, v := range list {
		if v == want {
			return
		}
	}
	t.Errorf("expected list to contain %s, got %v", want, list)
}