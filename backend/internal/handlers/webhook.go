package handlers

import (
	"database/sql"
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send webhook: " + err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true, "message": "Webhook notification sent"})
	}
}
