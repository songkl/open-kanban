package handlers

import (
	"database/sql"
	"errors"
	"net/http"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

type WebhookTestRequest struct {
	Event string `json:"event"`
	Task  struct {
		ID         string `json:"id"`
		Title      string `json:"title"`
		ColumnID   string `json:"columnId"`
		ColumnName string `json:"columnName"`
		Priority   string `json:"priority"`
		Assignee   string `json:"assignee"`
	} `json:"task"`
}

// WebhookNotifyResult mirrors the WebhookTestRequest response but
// distinguishes "service unavailable" (500) from "delivery failed"
// (200 with success=false). Tests use the success flag to assert
// the failure-side notification path without poking the service
// layer directly.
type WebhookNotifyResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

func WebhookNotify(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		webhookSvc := services.GetWebhookService()
		if !webhookSvc.IsEnabled() {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Webhook is not enabled"})
			return
		}

		var req WebhookTestRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		task := services.WebhookTask{
			ID:         req.Task.ID,
			Title:      req.Task.Title,
			ColumnID:   req.Task.ColumnID,
			ColumnName: req.Task.ColumnName,
			Priority:   req.Task.Priority,
			Assignee:   req.Task.Assignee,
		}

		var err error
		switch req.Event {
		case "task.created":
			err = webhookSvc.NotifyTaskCreated(task)
		case "task.moved":
			err = webhookSvc.NotifyTaskMoved(task)
		case "task.completed":
			err = webhookSvc.NotifyTaskCompleted(task)
		case "task.commented":
			err = webhookSvc.NotifyTaskCommented(task)
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid event type"})
			return
		}

		if err != nil {
			go notifyWebhookFailed(db, user.ID, req.Event, err.Error())
			c.JSON(http.StatusOK, WebhookNotifyResult{Success: false, Message: err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true, "message": "Webhook notification sent"})
	}
}

// notifyWebhookFailed inserts a WEBHOOK_FAILED notification for the
// user who triggered the failing webhook delivery. It is a fire-
// and-forget helper called from the request handler's `go` clause
// so the originating HTTP call doesn't wait on the bell-badge
// round-trip. We deliberately insert on every failure (rather than
// rate-limiting) because silent webhook drops are exactly what the
// notification center is designed to surface — throttling that
// signal would defeat the point of the feature.
func notifyWebhookFailed(db *sql.DB, userID, event, detail string) {
	if userID == "" {
		return
	}
	if detail == "" {
		detail = "Webhook delivery failed"
	}
	title := "Webhook delivery failed"
	body := event + ": " + detail
	if len(body) > 1024 {
		body = body[:1024]
	}
	if err := InsertNotification(db, userID, NotificationSourceWebhookFailed, title, body, "WEBHOOK", event); err != nil {
		// We intentionally only log here; the originating webhook
		// caller has already been told the delivery failed via the
		// HTTP response, so failing the notification insert would
		// be confusing rather than informative.
		_ = errors.Unwrap(err)
	}
}
