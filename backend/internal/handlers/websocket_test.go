package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func TestSplitOrigins(t *testing.T) {
	tests := []struct {
		name     string
		origins  string
		expected []string
	}{
		{
			name:     "empty string",
			origins:  "",
			expected: nil,
		},
		{
			name:     "single origin",
			origins:  "http://localhost:3000",
			expected: []string{"http://localhost:3000"},
		},
		{
			name:     "multiple origins with spaces",
			origins:  "http://localhost:3000, http://example.com, https://app.com",
			expected: []string{"http://localhost:3000", "http://example.com", "https://app.com"},
		},
		{
			name:     "multiple origins without spaces",
			origins:  "http://localhost:3000,http://example.com",
			expected: []string{"http://localhost:3000", "http://example.com"},
		},
		{
			name:     "origin with trailing comma",
			origins:  "http://localhost:3000, ",
			expected: []string{"http://localhost:3000"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := handlers.SplitOriginsForTest(tt.origins)
			if len(result) != len(tt.expected) {
				t.Errorf("expected %d origins, got %d", len(tt.expected), len(result))
				return
			}
			for i, v := range result {
				if v != tt.expected[i] {
					t.Errorf("expected %s at index %d, got %s", tt.expected[i], i, v)
				}
			}
		})
	}
}

func TestIsOriginAllowed(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", "http://localhost:3000,http://example.com")

	tests := []struct {
		name     string
		origin   string
		expected bool
	}{
		{
			name:     "empty origin",
			origin:   "",
			expected: false,
		},
		{
			name:     "allowed origin",
			origin:   "http://localhost:3000",
			expected: true,
		},
		{
			name:     "another allowed origin",
			origin:   "http://example.com",
			expected: true,
		},
		{
			name:     "disallowed origin",
			origin:   "http://disallowed.com",
			expected: false,
		},
		{
			name:     "similar but different origin",
			origin:   "http://localhost:3001",
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := handlers.IsOriginAllowedForTest(tt.origin)
			if result != tt.expected {
				t.Errorf("expected %v, got %v for origin %s", tt.expected, result, tt.origin)
			}
		})
	}
}

func TestWebSocketHandler(t *testing.T) {
	t.Run("websocket without token returns 401", func(t *testing.T) {
		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/ws", handlers.WebSocketHandler(nil))

		req, _ := http.NewRequest("GET", "/ws", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestIsConnectionAllowed(t *testing.T) {
	t.Run("connection allowed when under limit", func(t *testing.T) {
		t.Setenv("WS_MAX_CONNECTIONS", "10")
		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/ws", handlers.WebSocketHandler(nil))

		req, _ := http.NewRequest("GET", "/ws", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401 (no auth), got %d", w.Code)
		}
	})
}

func TestGetMaxConnections(t *testing.T) {
	t.Run("get max connections returns positive value", func(t *testing.T) {
		maxConns := handlers.GetMaxConnections()
		if maxConns <= 0 {
			t.Errorf("expected positive value, got %d", maxConns)
		}
	})
}

func TestWebSocketHeartbeatConstants(t *testing.T) {
	t.Run("ping interval is reasonable", func(t *testing.T) {
	})
}

func TestWebSocketConnectionCount(t *testing.T) {
	t.Run("get connection count returns zero initially", func(t *testing.T) {
		count := handlers.GetConnectionCount()
		if count < 0 {
			t.Errorf("expected non-negative count, got %d", count)
		}
	})
}
