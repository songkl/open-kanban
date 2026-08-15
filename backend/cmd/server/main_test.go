package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
)

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	prev, had := os.LookupEnv(key)
	_ = os.Unsetenv(key)
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, prev)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func TestCorsMiddlewareDefaultAllowsLocalhost(t *testing.T) {
	gin.SetMode(gin.TestMode)
	unsetEnv(t, "ALLOWED_ORIGINS")
	t.Setenv("PORT", "8080")

	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/probe", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("Origin", "http://localhost:8080")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:8080" {
		t.Errorf("expected Access-Control-Allow-Origin=http://localhost:8080, got %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("expected Access-Control-Allow-Credentials=true, got %q", got)
	}
}

func TestCorsMiddlewareDefaultRejectsOther(t *testing.T) {
	gin.SetMode(gin.TestMode)
	unsetEnv(t, "ALLOWED_ORIGINS")
	t.Setenv("PORT", "8080")

	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/probe", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("Origin", "http://evil.com")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no Access-Control-Allow-Origin for disallowed origin, got %q", got)
	}
}

func TestCorsMiddlewareExplicitOverrides(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("ALLOWED_ORIGINS", "https://app.example.com")
	t.Setenv("PORT", "8080")

	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/probe", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	allowedReq, _ := http.NewRequest(http.MethodGet, "/probe", nil)
	allowedReq.Header.Set("Origin", "https://app.example.com")
	allowedW := httptest.NewRecorder()
	router.ServeHTTP(allowedW, allowedReq)
	if got := allowedW.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("expected Access-Control-Allow-Origin=https://app.example.com, got %q", got)
	}

	rejectedReq, _ := http.NewRequest(http.MethodGet, "/probe", nil)
	rejectedReq.Header.Set("Origin", "http://localhost:8080")
	rejectedW := httptest.NewRecorder()
	router.ServeHTTP(rejectedW, rejectedReq)
	if got := rejectedW.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no Access-Control-Allow-Origin for default origin when explicit list set, got %q", got)
	}
}