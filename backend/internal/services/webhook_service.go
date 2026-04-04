package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

type WebhookService struct {
	enabled bool
	url     string
	secret  string
	client  *http.Client
}

type WebhookPayload struct {
	Event     string      `json:"event"`
	Task      WebhookTask `json:"task"`
	Timestamp string      `json:"timestamp"`
}

type WebhookTask struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	ColumnID   string `json:"columnId"`
	ColumnName string `json:"columnName"`
	Priority   string `json:"priority"`
	Assignee   string `json:"assignee"`
}

var webhookService *WebhookService

func InitWebhookService() *WebhookService {
	enabled := os.Getenv("WEBHOOK_ENABLED") == "true"
	url := os.Getenv("WEBHOOK_URL")
	secret := os.Getenv("WEBHOOK_SECRET")

	webhookService = &WebhookService{
		enabled: enabled,
		url:     url,
		secret:  secret,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	if enabled && url != "" {
		log.Printf("[Webhook] Service enabled, URL: %s", url)
	} else if enabled {
		log.Printf("[Webhook] Service enabled but WEBHOOK_URL not set")
	}

	return webhookService
}

func GetWebhookService() *WebhookService {
	if webhookService == nil {
		return InitWebhookService()
	}
	return webhookService
}

func (s *WebhookService) IsEnabled() bool {
	return s.enabled && s.url != ""
}

func (s *WebhookService) SendWebhook(event string, task WebhookTask) error {
	if !s.IsEnabled() {
		return nil
	}

	payload := WebhookPayload{
		Event:     event,
		Task:      task,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal webhook payload: %w", err)
	}

	req, err := http.NewRequest("POST", s.url, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create webhook request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Open-Kanban-Webhook/1.0")

	if s.secret != "" {
		req.Header.Set("X-Webhook-Secret", s.secret)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send webhook: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned non-success status: %d", resp.StatusCode)
	}

	log.Printf("[Webhook] Successfully sent %s for task %s", event, task.ID)
	return nil
}

func (s *WebhookService) NotifyTaskCreated(task WebhookTask) error {
	return s.SendWebhook("task.created", task)
}

func (s *WebhookService) NotifyTaskMoved(task WebhookTask) error {
	return s.SendWebhook("task.moved", task)
}

func (s *WebhookService) NotifyTaskCompleted(task WebhookTask) error {
	return s.SendWebhook("task.completed", task)
}

func (s *WebhookService) NotifyTaskCommented(task WebhookTask) error {
	return s.SendWebhook("task.commented", task)
}
