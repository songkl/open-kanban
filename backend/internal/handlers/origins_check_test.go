package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestCheckOriginAllowed (s-1260 / PM review s-1258 P2-11) covers
// the GET /api/v1/origins/check endpoint the SPA calls before
// opening the WebSocket. The handler must report whether the
// request's Origin header is on the allow-list and surface the
// human-readable hint when it isn't, so the toast can tell the user
// *why* the handshake failed instead of just "reconnecting (2/10)".
func TestCheckOriginAllowed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("allowed origin returns allowed=true and no hint", func(t *testing.T) {
		t.Setenv("ALLOWED_ORIGINS", "http://localhost:8080,http://localhost:8081")

		router := gin.New()
		router.GET("/api/v1/origins/check", CheckOriginAllowed(nil))

		req, _ := http.NewRequest("GET", "/api/v1/origins/check", nil)
		req.Header.Set("Origin", "http://localhost:8081")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var body struct {
			Origin    string   `json:"origin"`
			Allowed   bool     `json:"allowed"`
			AllowList []string `json:"allowList"`
			Hint      string   `json:"hint"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if body.Origin != "http://localhost:8081" {
			t.Errorf("expected origin echoed, got %q", body.Origin)
		}
		if !body.Allowed {
			t.Errorf("expected allowed=true, got false")
		}
		if body.Hint != "" {
			t.Errorf("expected empty hint when origin is allowed, got %q", body.Hint)
		}
		if len(body.AllowList) == 0 {
			t.Errorf("expected allowList to surface the configured origins")
		}
	})

	t.Run("disallowed origin returns allowed=false plus a non-empty hint", func(t *testing.T) {
		t.Setenv("ALLOWED_ORIGINS", "http://localhost:8080")

		router := gin.New()
		router.GET("/api/v1/origins/check", CheckOriginAllowed(nil))

		req, _ := http.NewRequest("GET", "/api/v1/origins/check", nil)
		req.Header.Set("Origin", "http://localhost:8082")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var body struct {
			Origin    string   `json:"origin"`
			Allowed   bool     `json:"allowed"`
			AllowList []string `json:"allowList"`
			Hint      string   `json:"hint"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if body.Allowed {
			t.Errorf("expected allowed=false for an off-list origin")
		}
		if body.Hint == "" {
			t.Errorf("expected hint to be populated for a disallowed origin")
		}
		// Sanity check: the hint mentions both the failing origin
		// and ALLOWED_ORIGINS so the user knows where to look.
		if want := "http://localhost:8082"; !strings.Contains(body.Hint, want) {
			t.Errorf("hint should echo the rejected origin; got %q", body.Hint)
		}
		if want := "ALLOWED_ORIGINS"; !strings.Contains(body.Hint, want) {
			t.Errorf("hint should mention ALLOWED_ORIGINS; got %q", body.Hint)
		}
	})

	t.Run("falls back to Referer when Origin is absent", func(t *testing.T) {
		t.Setenv("ALLOWED_ORIGINS", "http://localhost:8080")

		router := gin.New()
		router.GET("/api/v1/origins/check", CheckOriginAllowed(nil))

		req, _ := http.NewRequest("GET", "/api/v1/origins/check", nil)
		req.Header.Set("Referer", "http://localhost:8080/dashboard")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var body struct {
			Origin  string `json:"origin"`
			Allowed bool   `json:"allowed"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		// Referer has a path; the handler should still echo it
		// verbatim — equality with the configured origin is up
		// to the operator's ALLOWED_ORIGINS list, not us.
		if body.Origin == "" {
			t.Errorf("expected origin to fall back to Referer header")
		}
	})
}