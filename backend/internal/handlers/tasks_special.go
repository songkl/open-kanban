package handlers

import (
	"database/sql"
	"fmt"
	"net/http"

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

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot archive tasks"})
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

		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "Can only archive tasks you created"})
				return
			}
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

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot complete tasks"})
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

		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "Can only complete tasks you created"})
				return
			}
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
