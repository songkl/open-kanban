package services_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"open-kanban/internal/services"

	"github.com/stretchr/testify/assert"
)

func resetWebhookService() {
	services.InitWebhookService()
}

func TestInitWebhookService(t *testing.T) {
	os.Setenv("WEBHOOK_ENABLED", "true")
	os.Setenv("WEBHOOK_URL", "https://example.com/webhook")
	os.Setenv("WEBHOOK_SECRET", "test-secret")
	defer func() {
		os.Unsetenv("WEBHOOK_ENABLED")
		os.Unsetenv("WEBHOOK_URL")
		os.Unsetenv("WEBHOOK_SECRET")
	}()

	ws := services.InitWebhookService()
	assert.NotNil(t, ws)
	assert.True(t, ws.IsEnabled())
}

func TestGetWebhookService(t *testing.T) {
	os.Setenv("WEBHOOK_ENABLED", "false")
	os.Setenv("WEBHOOK_URL", "")
	os.Setenv("WEBHOOK_SECRET", "")
	defer func() {
		os.Unsetenv("WEBHOOK_ENABLED")
		os.Unsetenv("WEBHOOK_URL")
		os.Unsetenv("WEBHOOK_SECRET")
	}()

	services.InitWebhookService()
	ws := services.GetWebhookService()
	assert.NotNil(t, ws)
	assert.False(t, ws.IsEnabled())
}

func TestWebhookService_IsEnabled(t *testing.T) {
	tests := []struct {
		name     string
		enabled  bool
		url      string
		expected bool
	}{
		{"enabled with url", true, "https://example.com", true},
		{"enabled without url", true, "", false},
		{"disabled with url", false, "https://example.com", false},
		{"disabled without url", false, "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			os.Setenv("WEBHOOK_ENABLED", "")
			os.Setenv("WEBHOOK_URL", "")
			os.Setenv("WEBHOOK_SECRET", "")

			if tt.enabled {
				os.Setenv("WEBHOOK_ENABLED", "true")
			}
			if tt.url != "" {
				os.Setenv("WEBHOOK_URL", tt.url)
			}

			ws := services.InitWebhookService()
			assert.Equal(t, tt.expected, ws.IsEnabled())
		})
	}
}

func TestWebhookService_SendWebhook(t *testing.T) {
	t.Run("SendWebhook when disabled returns nil", func(t *testing.T) {
		os.Setenv("WEBHOOK_ENABLED", "false")
		os.Setenv("WEBHOOK_URL", "")
		defer func() {
			os.Unsetenv("WEBHOOK_ENABLED")
			os.Unsetenv("WEBHOOK_URL")
		}()

		ws := services.InitWebhookService()
		err := ws.SendWebhook("test.event", services.WebhookTask{})
		assert.NoError(t, err)
	})

	t.Run("SendWebhook when enabled but no url returns nil", func(t *testing.T) {
		os.Setenv("WEBHOOK_ENABLED", "true")
		os.Setenv("WEBHOOK_URL", "")
		defer func() {
			os.Unsetenv("WEBHOOK_ENABLED")
			os.Unsetenv("WEBHOOK_URL")
		}()

		ws := services.InitWebhookService()
		err := ws.SendWebhook("test.event", services.WebhookTask{})
		assert.NoError(t, err)
	})

	t.Run("SendWebhook with valid endpoint returns success", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "POST", r.Method)
			assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
			assert.Equal(t, "Open-Kanban-Webhook/1.0", r.Header.Get("User-Agent"))
			assert.Equal(t, "test-secret", r.Header.Get("X-Webhook-Secret"))
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()

		os.Setenv("WEBHOOK_ENABLED", "true")
		os.Setenv("WEBHOOK_URL", server.URL)
		os.Setenv("WEBHOOK_SECRET", "test-secret")
		defer func() {
			os.Unsetenv("WEBHOOK_ENABLED")
			os.Unsetenv("WEBHOOK_URL")
			os.Unsetenv("WEBHOOK_SECRET")
		}()

		ws := services.InitWebhookService()
		task := services.WebhookTask{
			ID:         "task-1",
			Title:      "Test Task",
			ColumnID:   "col-1",
			ColumnName: "To Do",
			Priority:   "high",
			Assignee:   "user-1",
		}
		err := ws.SendWebhook("task.created", task)
		assert.NoError(t, err)
	})

	t.Run("SendWebhook with server error returns error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer server.Close()

		os.Setenv("WEBHOOK_ENABLED", "true")
		os.Setenv("WEBHOOK_URL", server.URL)
		os.Setenv("WEBHOOK_SECRET", "test-secret")
		defer func() {
			os.Unsetenv("WEBHOOK_ENABLED")
			os.Unsetenv("WEBHOOK_URL")
			os.Unsetenv("WEBHOOK_SECRET")
		}()

		ws := services.InitWebhookService()
		task := services.WebhookTask{ID: "task-1"}
		err := ws.SendWebhook("task.created", task)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "non-success status: 500")
	})
}

func TestWebhookService_NotifyMethods(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	os.Setenv("WEBHOOK_ENABLED", "true")
	os.Setenv("WEBHOOK_URL", server.URL)
	os.Setenv("WEBHOOK_SECRET", "")
	defer func() {
		os.Unsetenv("WEBHOOK_ENABLED")
		os.Unsetenv("WEBHOOK_URL")
		os.Unsetenv("WEBHOOK_SECRET")
	}()

	ws := services.InitWebhookService()
	task := services.WebhookTask{ID: "task-1", Title: "Test"}

	err := ws.NotifyTaskCreated(task)
	assert.NoError(t, err)

	err = ws.NotifyTaskMoved(task)
	assert.NoError(t, err)

	err = ws.NotifyTaskCompleted(task)
	assert.NoError(t, err)

	err = ws.NotifyTaskCommented(task)
	assert.NoError(t, err)
}

func TestWebhookService_SendWebhook_NoSecret(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hasSecret := r.Header["X-Webhook-Secret"]
		assert.False(t, hasSecret, "X-Webhook-Secret header should not be set when no secret is configured")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	os.Setenv("WEBHOOK_ENABLED", "true")
	os.Setenv("WEBHOOK_URL", server.URL)
	os.Setenv("WEBHOOK_SECRET", "")
	defer func() {
		os.Unsetenv("WEBHOOK_ENABLED")
		os.Unsetenv("WEBHOOK_URL")
		os.Unsetenv("WEBHOOK_SECRET")
	}()

	ws := services.InitWebhookService()
	err := ws.SendWebhook("test.event", services.WebhookTask{})
	assert.NoError(t, err)
}
