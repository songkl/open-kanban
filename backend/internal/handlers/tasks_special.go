package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func ArchiveTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Task ID is required"})
			return
		}

		columnID, err := getColumnIDForTask(db, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to archive this task"})
			return
		}

		allowed, err := canModifyTask(db, user, id)
		if err != nil || !allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": "Can only archive tasks you created"})
			return
		}

		var req ArchiveTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		archived := true
		if req.Archived != nil {
			archived = *req.Archived
		}

		taskService := services.NewTaskService(db)
		_, err = taskService.ArchiveTask(id, archived)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to archive"})
			return
		}

		if archived {
			var taskTitle string
			if err := db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle); err != nil {
				taskTitle = ""
			}
			LogActivity(db, user.ID, "COMPLETE_TASK", "TASK", id, taskTitle, "", c.ClientIP(), getRequestSource(c))
		}

		broadcast()
		GetTask(db)(c)
	}
}

func CompleteTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Task ID is required"})
			return
		}

		columnID, err := getColumnIDForTask(db, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to operate on this task"})
			return
		}

		allowed, err := canModifyTask(db, user, id)
		if err != nil || !allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": "Can only complete tasks you created"})
			return
		}

		taskService := services.NewTaskService(db)
		_, err = taskService.CompleteTask(id)
		if err != nil {
			if gin.Mode() == gin.DebugMode {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to complete task", "detail": err.Error()})
			} else {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to complete task"})
			}
			return
		}

		var taskTitle string
		if err := db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle); err != nil {
			taskTitle = ""
		}
		var oldStatus, newStatus sql.NullString
		if err := db.QueryRow("SELECT status FROM columns WHERE id = ?", columnID).Scan(&oldStatus); err != nil {
			oldStatus = sql.NullString{Valid: false}
		}

		newColumnID, err := getColumnIDForTask(db, id)
		if err != nil {
			newColumnID = ""
		}
		if newColumnID != "" {
			if err := db.QueryRow("SELECT status FROM columns WHERE id = ?", newColumnID).Scan(&newStatus); err != nil {
				newStatus = sql.NullString{Valid: false}
			}
		}

		oldStatusVal := ""
		if oldStatus.Valid {
			oldStatusVal = oldStatus.String
		}
		newStatusVal := ""
		if newStatus.Valid {
			newStatusVal = newStatus.String
		}
		details := fmt.Sprintf("Status: '%s' → '%s'", oldStatusVal, newStatusVal)
		LogActivity(db, user.ID, "UPDATE_TASK", "TASK", id, taskTitle, details, c.ClientIP(), getRequestSource(c))

		broadcast()
		GetTask(db)(c)

		go func() {
			webhookSvc := services.GetWebhookService()
			columnName := getColumnName(db, newColumnID)
			var priority string
			var assigneePtr *string
			if err := db.QueryRow("SELECT priority, assignee FROM tasks WHERE id = ?", id).Scan(&priority, &assigneePtr); err != nil {
				priority = ""
				assigneePtr = nil
			}
			assignee := derefString(assigneePtr)
			webhookSvc.NotifyTaskMoved(services.WebhookTask{
				ID:         id,
				Title:      taskTitle,
				ColumnID:   newColumnID,
				ColumnName: columnName,
				Priority:   priority,
				Assignee:   assignee,
			})
			if newStatusVal == "done" {
				webhookSvc.NotifyTaskCompleted(services.WebhookTask{
					ID:         id,
					Title:      taskTitle,
					ColumnID:   newColumnID,
					ColumnName: columnName,
					Priority:   priority,
					Assignee:   assignee,
				})
			}
		}()
	}
}

// ReorderTasksRequest represents the request body for batch task reorder
type ReorderTasksRequest struct {
	Tasks []ReorderTaskItemRequest `json:"tasks"`
}

// ReorderTaskItemRequest represents a single task reorder entry
type ReorderTaskItemRequest struct {
	ID       string `json:"id"`
	ColumnID string `json:"columnId"`
	Position int    `json:"position"`
}

// ReorderTasks updates positions of multiple tasks in one transaction.
// Supports reordering within a column or moving tasks between columns.
func ReorderTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
			return
		}

		var req ReorderTasksRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		if len(req.Tasks) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Tasks array is required"})
			return
		}

		if len(req.Tasks) > 500 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Too many tasks in one reorder request"})
			return
		}

		seen := make(map[string]bool)
		for _, t := range req.Tasks {
			if strings.TrimSpace(t.ID) == "" || strings.TrimSpace(t.ColumnID) == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Each task must include id and columnId"})
				return
			}
			if seen[t.ID] {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Duplicate task id: " + t.ID})
				return
			}
			seen[t.ID] = true

			if !checkColumnAccessWithBoardFallback(db, user.ID, t.ColumnID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify tasks in column " + t.ColumnID})
				return
			}
		}

		input := services.ReorderTasksInput{
			Items: make([]services.ReorderTaskItem, 0, len(req.Tasks)),
		}
		for _, t := range req.Tasks {
			input.Items = append(input.Items, services.ReorderTaskItem{
				TaskID:   t.ID,
				ColumnID: t.ColumnID,
				Position: t.Position,
			})
		}

		taskService := services.NewTaskService(db)
		if err := taskService.ReorderTasks(input); err != nil {
			ServerError(c, "Failed to reorder tasks", err)
			return
		}

		var ids []string
		for _, t := range req.Tasks {
			ids = append(ids, t.ID)
		}
		details := fmt.Sprintf("Reordered %d tasks", len(req.Tasks))
		for _, t := range req.Tasks {
			LogActivity(db, user.ID, "UPDATE_TASK", "TASK", t.ID, "", "", c.ClientIP(), getRequestSource(c))
		}
		_ = ids

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"count":   len(req.Tasks),
			"details": details,
		})
	}
}
