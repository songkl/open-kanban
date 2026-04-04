package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

type TestStruct struct {
	Name  string `json:"name" validate:"required"`
	Email string `json:"email" validate:"required,email"`
	Age   int    `json:"age" validate:"required,min=0,max=150"`
}

func TestValidateRequestMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("ValidateRequest passes valid data", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequest(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		body := map[string]interface{}{"name": "John", "email": "john@example.com", "age": 25}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("ValidateRequest returns 400 for missing required field", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequest(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		body := map[string]interface{}{"email": "john@example.com", "age": 25}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("ValidateRequest returns 400 for invalid email", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequest(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		body := map[string]interface{}{"name": "John", "email": "invalid-email", "age": 25}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("ValidateRequest returns 400 for out of range age", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequest(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		body := map[string]interface{}{"name": "John", "email": "john@example.com", "age": 200}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("ValidateRequest returns 400 for invalid JSON", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequest(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer([]byte("invalid json")))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestValidateRequestOnlyMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("ValidateRequestOnly returns 400 for invalid data", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", handlers.ValidateRequestOnly(&TestStruct{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		body := map[string]interface{}{"name": "", "email": "invalid", "age": -5}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestBindAndValidate(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("BindAndValidate returns error for invalid JSON", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", func(c *gin.Context) {
			var s TestStruct
			err := handlers.BindAndValidate(c, &s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			} else {
				c.JSON(http.StatusOK, gin.H{"success": true})
			}
		})

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer([]byte("invalid json")))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("BindAndValidate returns error for validation failure", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", func(c *gin.Context) {
			var s TestStruct
			err := handlers.BindAndValidate(c, &s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			} else {
				c.JSON(http.StatusOK, gin.H{"success": true})
			}
		})

		body := map[string]interface{}{"name": "", "email": "invalid", "age": -1}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("BindAndValidate succeeds with valid data", func(t *testing.T) {
		router := gin.New()
		router.POST("/test", func(c *gin.Context) {
			var s TestStruct
			err := handlers.BindAndValidate(c, &s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			} else {
				c.JSON(http.StatusOK, gin.H{"success": true, "name": s.Name})
			}
		})

		body := map[string]interface{}{"name": "John", "email": "john@example.com", "age": 30}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/test", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["name"] != "John" {
			t.Errorf("expected name 'John', got %v", resp["name"])
		}
	})
}
