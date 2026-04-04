package handlers

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

type AppError struct {
	Code       int    `json:"-"`
	Message    string `json:"error"`
	Detail     string `json:"detail,omitempty"`
	IsExpected bool   `json:"-"`
}

func (e *AppError) Error() string {
	if e.Detail != "" {
		return e.Message + ": " + e.Detail
	}
	return e.Message
}

func NewAppError(code int, message string, detail string) *AppError {
	return &AppError{
		Code:       code,
		Message:    message,
		Detail:     detail,
		IsExpected: code >= 400 && code < 500,
	}
}

func NewExpectedError(code int, message string) *AppError {
	return &AppError{
		Code:       code,
		Message:    message,
		IsExpected: true,
	}
}

func NewUnexpectedError(message string, detail string) *AppError {
	return &AppError{
		Code:       http.StatusInternalServerError,
		Message:    message,
		Detail:     detail,
		IsExpected: false,
	}
}

func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if len(c.Errors) == 0 {
			return
		}

		err := c.Errors.Last()
		if err == nil {
			return
		}

		if appErr, ok := err.Err.(*AppError); ok {
			if appErr.IsExpected || gin.Mode() == gin.DebugMode {
				c.JSON(appErr.Code, gin.H{
					"error":  appErr.Message,
					"detail": appErr.Detail,
				})
			} else {
				c.JSON(appErr.Code, gin.H{
					"error": appErr.Message,
				})
			}
			return
		}

		status := c.Writer.Status()
		if status >= 500 {
			if gin.Mode() == gin.DebugMode {
				c.JSON(status, gin.H{
					"error":  "Internal server error",
					"detail": err.Error(),
				})
			} else {
				c.JSON(status, gin.H{
					"error": "Internal server error",
				})
			}
		} else if status >= 400 {
			c.JSON(status, gin.H{
				"error": err.Error(),
			})
		}
	}
}

func RecoveryWithErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if err := recover(); err != nil {
				requestID := GetRequestID(c)
				slog.Error("Panic recovered", "error", err, "request_id", requestID, "path", c.Request.URL.Path, "method", c.Request.Method)
				if gin.Mode() == gin.DebugMode {
					c.JSON(http.StatusInternalServerError, gin.H{
						"error":  "Internal server error",
						"detail": err,
					})
				} else {
					c.JSON(http.StatusInternalServerError, gin.H{
						"error": "Internal server error",
					})
				}
				c.Abort()
			}
		}()
		c.Next()
	}
}

func ErrorMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if len(c.Errors) > 0 {
			err := c.Errors.Last()
			if err == nil {
				return
			}

			status := c.Writer.Status()
			if status == 0 {
				status = http.StatusInternalServerError
			}

			if status >= 500 {
				if gin.Mode() == gin.DebugMode {
					c.JSON(status, gin.H{
						"error":  "Internal server error",
						"detail": err.Error(),
					})
				} else {
					c.JSON(status, gin.H{
						"error": "Internal server error",
					})
				}
			}
		}
	}
}

func ServerError(c *gin.Context, message string, err error) {
	if gin.Mode() == gin.DebugMode && err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":  message,
			"detail": err.Error(),
		})
	} else {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": message,
		})
	}
}
