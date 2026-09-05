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

func TestOAuthGateBlocksWhenDisabled(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if err := oauth.SetConfig(db, "oauth_enabled", "0"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	gate := gin.HandlerFunc(func(c *gin.Context) {
		if !oauth.IsOAuthEnabled(db) {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error":             "oauth_disabled",
				"error_description": "OAuth 2.1 is disabled by administrator.",
			})
			return
		}
		c.Next()
	})

	r := gin.New()
	r.POST("/oauth/register", gate, oauth.RegisterClient(db))

	body := `{"client_name": "test"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error"] != "oauth_disabled" {
		t.Errorf("expected oauth_disabled, got %v", resp)
	}
}

func TestOAuthGatePassesWhenEnabled(t *testing.T) {
	db := setupRegisterDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	if !oauth.IsOAuthEnabled(db) {
		t.Fatal("expected default to be enabled")
	}

	gate := gin.HandlerFunc(func(c *gin.Context) {
		if !oauth.IsOAuthEnabled(db) {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "oauth_disabled"})
			return
		}
		c.Next()
	})

	r := gin.New()
	r.POST("/oauth/register", gate, oauth.RegisterClient(db))

	body := `{"client_name": "test"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("expected 201 when OAuth enabled, got %d", w.Code)
	}
}
