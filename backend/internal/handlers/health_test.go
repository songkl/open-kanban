package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func TestHealthCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("HealthCheck returns 200 with ok status", func(t *testing.T) {
		router := gin.New()
		router.GET("/health", handlers.HealthCheck)

		req, _ := http.NewRequest("GET", "/health", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp handlers.HealthResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if resp.Status != "ok" {
			t.Errorf("expected status 'ok', got %q", resp.Status)
		}

		if resp.Timestamp == "" {
			t.Error("expected timestamp to be present")
		}
	})
}

func TestGetRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("GetRequestID returns request ID from context", func(t *testing.T) {
		router := gin.New()
		router.Use(func(c *gin.Context) {
			c.Set(handlers.RequestIDKey, "test-request-id-123")
			c.Next()
		})
		router.GET("/test", func(c *gin.Context) {
			requestID := handlers.GetRequestID(c)
			c.JSON(http.StatusOK, gin.H{"request_id": requestID})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]string
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["request_id"] != "test-request-id-123" {
			t.Errorf("expected request_id 'test-request-id-123', got %q", resp["request_id"])
		}
	})

	t.Run("GetRequestID returns empty string when not set", func(t *testing.T) {
		router := gin.New()
		router.GET("/test", func(c *gin.Context) {
			requestID := handlers.GetRequestID(c)
			c.JSON(http.StatusOK, gin.H{"request_id": requestID})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]string
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["request_id"] != "" {
			t.Errorf("expected request_id '', got %q", resp["request_id"])
		}
	})
}

func TestRequestLoggerMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("RequestLoggerMiddleware sets request ID header", func(t *testing.T) {
		router := gin.New()
		router.Use(handlers.RequestLoggerMiddleware())
		router.GET("/test", func(c *gin.Context) {
			requestID := handlers.GetRequestID(c)
			c.JSON(http.StatusOK, gin.H{"request_id": requestID})
		})

		req, _ := http.NewRequest("GET", "/test?foo=bar", nil)
		req.RemoteAddr = "192.168.1.1:1234"
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		requestID := w.Header().Get("X-Request-ID")
		if requestID == "" {
			t.Error("expected X-Request-ID header to be set")
		}

		if len(requestID) != 32 {
			t.Errorf("expected X-Request-ID length 32, got %d", len(requestID))
		}
	})

	t.Run("RequestLoggerMiddleware logs request", func(t *testing.T) {
		router := gin.New()
		router.Use(handlers.RequestLoggerMiddleware())
		router.GET("/test", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}
	})

	t.Run("RequestLoggerMiddleware handles 4xx errors", func(t *testing.T) {
		router := gin.New()
		router.Use(handlers.RequestLoggerMiddleware())
		router.GET("/test", func(c *gin.Context) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad request"})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d", w.Code)
		}
	})
}
