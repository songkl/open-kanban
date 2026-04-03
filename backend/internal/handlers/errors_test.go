package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func TestServerError(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("with error in debug mode should include detail", func(t *testing.T) {
		gin.SetMode(gin.DebugMode)
		defer gin.SetMode(gin.TestMode)

		router := gin.New()
		router.GET("/test", func(c *gin.Context) {
			handlers.ServerError(c, "测试错误", &testError{"具体错误详情"})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected status 500, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["error"] != "测试错误" {
			t.Errorf("expected error '测试错误', got %v", resp["error"])
		}
		if resp["detail"] == nil {
			t.Errorf("expected detail to be present in debug mode")
		}
	})

	t.Run("with nil error should not include detail", func(t *testing.T) {
		router := gin.New()
		router.GET("/test", func(c *gin.Context) {
			handlers.ServerError(c, "测试错误", nil)
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected status 500, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["error"] != "测试错误" {
			t.Errorf("expected error '测试错误', got %v", resp["error"])
		}
		if resp["detail"] != nil {
			t.Errorf("expected detail to not be present, got %v", resp["detail"])
		}
	})

	t.Run("with error in test mode should not include detail", func(t *testing.T) {
		gin.SetMode(gin.TestMode)

		router := gin.New()
		router.GET("/test", func(c *gin.Context) {
			handlers.ServerError(c, "测试错误", &testError{"具体错误详情"})
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected status 500, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["error"] != "测试错误" {
			t.Errorf("expected error '测试错误', got %v", resp["error"])
		}
		if resp["detail"] != nil {
			t.Errorf("expected detail to not be present in test mode, got %v", resp["detail"])
		}
	})
}

func TestAppError(t *testing.T) {
	t.Run("NewAppError creates expected error", func(t *testing.T) {
		err := handlers.NewAppError(400, "测试消息", "详细错误信息")
		if err.Code != 400 {
			t.Errorf("expected code 400, got %d", err.Code)
		}
		if err.Message != "测试消息" {
			t.Errorf("expected message '测试消息', got %q", err.Message)
		}
		if err.Detail != "详细错误信息" {
			t.Errorf("expected detail '详细错误信息', got %q", err.Detail)
		}
		if err.IsExpected != true {
			t.Errorf("expected IsExpected to be true")
		}
	})

	t.Run("NewExpectedError creates expected error", func(t *testing.T) {
		err := handlers.NewExpectedError(403, "禁止访问")
		if err.Code != 403 {
			t.Errorf("expected code 403, got %d", err.Code)
		}
		if err.Message != "禁止访问" {
			t.Errorf("expected message '禁止访问', got %q", err.Message)
		}
		if err.IsExpected != true {
			t.Errorf("expected IsExpected to be true")
		}
	})

	t.Run("NewUnexpectedError creates expected error", func(t *testing.T) {
		err := handlers.NewUnexpectedError("服务器错误", "数据库连接失败")
		if err.Code != 500 {
			t.Errorf("expected code 500, got %d", err.Code)
		}
		if err.Message != "服务器错误" {
			t.Errorf("expected message '服务器错误', got %q", err.Message)
		}
		if err.Detail != "数据库连接失败" {
			t.Errorf("expected detail '数据库连接失败', got %q", err.Detail)
		}
		if err.IsExpected != false {
			t.Errorf("expected IsExpected to be false")
		}
	})

	t.Run("Error method returns correct string", func(t *testing.T) {
		err := handlers.NewAppError(500, "错误", "详细信息")
		expected := "错误: 详细信息"
		if err.Error() != expected {
			t.Errorf("expected %q, got %q", expected, err.Error())
		}
	})

	t.Run("Error method returns message only when no detail", func(t *testing.T) {
		err := handlers.NewExpectedError(400, "简单错误")
		expected := "简单错误"
		if err.Error() != expected {
			t.Errorf("expected %q, got %q", expected, err.Error())
		}
	})
}

func TestErrorHandlerMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("ErrorHandler returns detailed error in debug mode", func(t *testing.T) {
		gin.SetMode(gin.DebugMode)
		defer gin.SetMode(gin.TestMode)

		router := gin.New()
		router.Use(handlers.ErrorHandler())
		router.GET("/test", func(c *gin.Context) {
			c.Error(&testError{Message: "详细错误信息"})
			c.Writer.WriteHeader(500)
		})

		req, _ := http.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != 500 {
			t.Errorf("expected status 500, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["error"] != "服务器内部错误" {
			t.Errorf("expected error '服务器内部错误', got %v", resp["error"])
		}
		if resp["detail"] == nil {
			t.Errorf("expected detail to be present in debug mode")
		}
	})
}

type testError struct {
	Message string
}

func (e *testError) Error() string {
	return e.Message
}
