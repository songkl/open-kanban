package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const RequestIDKey = "request_id"

type HealthResponse struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
}

func HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, HealthResponse{
		Status:    "ok",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

func RequestLoggerMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		requestID := generateRequestID()
		c.Set(RequestIDKey, requestID)
		c.Header("X-Request-ID", requestID)

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		logAttrs := []any{
			slog.String("request_id", requestID),
			slog.String("method", c.Request.Method),
			slog.String("path", path),
			slog.Int("status", status),
			slog.Duration("latency", latency),
			slog.String("ip", c.ClientIP()),
		}

		if query != "" {
			logAttrs = append(logAttrs, slog.String("query", query))
		}

		if len(c.Errors) > 0 {
			logAttrs = append(logAttrs, slog.String("errors", c.Errors.String()))
		}

		switch {
		case status >= 500:
			slog.Error("request completed", logAttrs...)
		case status >= 400:
			slog.Warn("request completed", logAttrs...)
		case gin.Mode() == gin.DebugMode:
			slog.Debug("request completed", logAttrs...)
		default:
			slog.Info("request completed", logAttrs...)
		}
	}
}

func generateRequestID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func GetRequestID(c *gin.Context) string {
	if id, exists := c.Get(RequestIDKey); exists {
		if requestID, ok := id.(string); ok {
			return requestID
		}
	}
	return ""
}
