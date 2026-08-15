package oauth_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"open-kanban/internal/oauth"
)

func issueAccessToken(t *testing.T, signer *oauth.Signer, issuer, audience, subject, clientID, scope string, ttl time.Duration) string {
	t.Helper()
	now := time.Now()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   subject,
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
		},
		ClientID:  clientID,
		Scope:     scope,
		TokenType: oauth.TokenTypeAccess,
	}
	tok, err := signer.Sign(claims)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return tok
}

func newBearerServer(t *testing.T, required ...string) (*gin.Engine, *oauth.Signer) {
	t.Helper()
	signer, db := seedSigner(t)
	t.Cleanup(func() { _ = db.Close() })
	r := gin.New()
	r.GET("/protected", oauth.RequireBearerToken(signer, required...), func(c *gin.Context) {
		claims := oauth.GetClaims(c)
		scopes := oauth.GetScopes(c)
		c.JSON(http.StatusOK, gin.H{
			"subject":   claims.Subject,
			"client_id": claims.ClientID,
			"scopes":    scopes.String(),
		})
	})
	return r, signer
}

func TestRequireBearerTokenAllowsValidToken(t *testing.T) {
	r, signer := newBearerServer(t)
	tok := issueAccessToken(t, signer, "http://example.com", "kanban", "user-1", "client-a", "kanban:read", time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"subject":"user-1"`) {
		t.Errorf("unexpected body: %s", w.Body.String())
	}
}

func TestRequireBearerTokenRejectsMissingHeader(t *testing.T) {
	r, _ := newBearerServer(t)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	www := w.Header().Get("WWW-Authenticate")
	if !strings.HasPrefix(www, "Bearer") {
		t.Errorf("expected WWW-Authenticate header, got %q", www)
	}
	if !strings.Contains(www, "authorization_uri=") {
		t.Errorf("expected authorization_uri in WWW-Authenticate, got %q", www)
	}
	if !strings.Contains(www, "resource_metadata=") {
		t.Errorf("expected resource_metadata in WWW-Authenticate, got %q", www)
	}
}

func TestRequireBearerTokenRejectsWrongScheme(t *testing.T) {
	r, _ := newBearerServer(t)
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Basic abc123")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestRequireBearerTokenRejectsExpiredToken(t *testing.T) {
	r, signer := newBearerServer(t)
	tok := issueAccessToken(t, signer, "http://example.com", "kanban", "user-1", "client-a", "kanban:read", -time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestRequireBearerTokenRejectsWrongAudience(t *testing.T) {
	r, signer := newBearerServer(t)
	tok := issueAccessToken(t, signer, "http://example.com", "different-aud", "user-1", "client-a", "kanban:read", time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestRequireBearerTokenEnforcesScope(t *testing.T) {
	r, signer := newBearerServer(t, oauth.ScopeTasksWrite)
	tok := issueAccessToken(t, signer, "http://example.com", "kanban", "user-1", "client-a", "kanban:read", time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
	www := w.Header().Get("WWW-Authenticate")
	if !strings.Contains(www, "insufficient_scope") {
		t.Errorf("expected insufficient_scope in WWW-Authenticate, got %q", www)
	}
	if !strings.Contains(www, oauth.ScopeTasksWrite) {
		t.Errorf("expected missing scope in WWW-Authenticate, got %q", www)
	}
}

func TestRequireBearerTokenAllowsMultipleRequiredScopesWhenAllPresent(t *testing.T) {
	r, signer := newBearerServer(t, oauth.ScopeKanbanRead, oauth.ScopeTasksWrite)
	tok := issueAccessToken(t, signer, "http://example.com", "kanban", "user-1", "client-a", "kanban:read tasks:write comments:write", time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestRequireBearerTokenStoresClaimsAndScopes(t *testing.T) {
	r, signer := newBearerServer(t)
	tok := issueAccessToken(t, signer, "http://example.com", "kanban", "user-1", "client-a", "kanban:read tasks:write", time.Minute)

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"client_id":"client-a"`) {
		t.Errorf("expected client_id in body, got %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `kanban:read tasks:write`) {
		t.Errorf("expected scopes string, got %s", w.Body.String())
	}
}

func TestGetClaimsAndScopesOutsideOAuthRoute(t *testing.T) {
	r := gin.New()
	r.GET("/plain", func(c *gin.Context) {
		if oauth.GetClaims(c) != nil {
			t.Error("expected nil claims outside OAuth middleware")
		}
		if oauth.GetScopes(c).String() != "" {
			t.Errorf("expected empty scopes, got %s", oauth.GetScopes(c).String())
		}
		c.Status(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/plain", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}