package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func CreateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot create tasks"})
			return
		}

		if !checkRateLimit("task:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		var req CreateTaskRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, req.ColumnID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to create task in this column"})
			return
		}

		taskService := services.NewTaskService(db)
		task, err := taskService.CreateTask(services.CreateTaskInput{
			Title:       req.Title,
			Description: req.Description,
			Priority:    req.Priority,
			Assignee:    req.Assignee,
			Meta:        req.Meta,
			ColumnID:    req.ColumnID,
			Position:    req.Position,
			Published:   req.Published,
			AgentID:     req.AgentID,
			AgentPrompt: req.AgentPrompt,
			CreatedBy:   user.ID,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create task: " + err.Error()})
			return
		}

		LogActivity(db, user.ID, "CREATE_TASK", "TASK", task.ID, task.Title, "", c.ClientIP(), getRequestSource(c))

		broadcast()

		go func() {
			webhookSvc := services.GetWebhookService()
			columnName := getColumnName(db, task.ColumnID)
			webhookSvc.NotifyTaskCreated(services.WebhookTask{
				ID:         task.ID,
				Title:      task.Title,
				ColumnID:   task.ColumnID,
				ColumnName: columnName,
				Priority:   task.Priority,
				Assignee:   derefString(task.Assignee),
			})
		}()

		if task.Published && task.AgentID != nil && *task.AgentID != "" {
			agentPrompt := ""
			if task.AgentPrompt != nil {
				agentPrompt = *task.AgentPrompt
			}
			taskService.TriggerAgentForTask(task.ID, *task.AgentID, agentPrompt, task.Title)
		}

		c.JSON(http.StatusOK, gin.H{
			"id":          task.ID,
			"title":       task.Title,
			"description": task.Description,
			"priority":    task.Priority,
			"assignee":    task.Assignee,
			"meta":        task.Meta,
			"columnId":    task.ColumnID,
			"position":    task.Position,
			"published":   task.Published,
			"archived":    false,
			"agentId":     task.AgentID,
			"agentPrompt": task.AgentPrompt,
			"createdBy":   user.ID,
			"createdAt":   task.CreatedAt,
			"updatedAt":   task.UpdatedAt,
			"comments":    []gin.H{},
		})
	}
}

func UpdateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot modify tasks"})
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
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this task"})
			return
		}

		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "Can only modify tasks you created"})
				return
			}
		}

		var req UpdateTaskRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		taskService := services.NewTaskService(db)
		task, changes, err := taskService.UpdateTask(id, user.ID, user.Role, services.UpdateTaskInput{
			Title:       req.Title,
			Description: req.Description,
			Priority:    req.Priority,
			Assignee:    req.Assignee,
			Meta:        req.Meta,
			ColumnID:    req.ColumnID,
			Position:    req.Position,
			Published:   req.Published,
			AgentID:     req.AgentID,
			AgentPrompt: req.AgentPrompt,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		details := ""
		if changes != nil && len(changes.Changes) > 0 {
			details = strings.Join(changes.Changes, ", ")
		}

		LogActivity(db, user.ID, "UPDATE_TASK", "TASK", id, task.Title, details, c.ClientIP(), getRequestSource(c))

		broadcast()

		if req.ColumnID != "" && req.ColumnID != columnID {
			go func() {
				webhookSvc := services.GetWebhookService()
				columnName := getColumnName(db, task.ColumnID)
				webhookSvc.NotifyTaskMoved(services.WebhookTask{
					ID:         task.ID,
					Title:      task.Title,
					ColumnID:   task.ColumnID,
					ColumnName: columnName,
					Priority:   task.Priority,
					Assignee:   derefString(task.Assignee),
				})
			}()
		}

		if req.Published != nil && *req.Published {
			currentAgentID := ""
			if req.AgentID != nil {
				currentAgentID = *req.AgentID
			} else if task.AgentID != nil {
				currentAgentID = *task.AgentID
			}
			if currentAgentID != "" {
				currentAgentPrompt := ""
				if req.AgentPrompt != nil {
					currentAgentPrompt = *req.AgentPrompt
				} else if task.AgentPrompt != nil {
					currentAgentPrompt = *task.AgentPrompt
				}
				taskService.TriggerAgentForTask(id, currentAgentID, currentAgentPrompt, task.Title)
			}
		}

		GetTask(db)(c)
	}
}

func DeleteTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot delete tasks"})
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

		if user.Role == "MEMBER" {
			var createdBy sql.NullString
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil {
				if err == sql.ErrNoRows {
					c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
					return
				}
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to query task: %v", err)})
				return
			}
			if !createdBy.Valid || createdBy.String != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "Can only delete tasks you created"})
				return
			}
		} else if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this task"})
			return
		}

		var taskTitle string
		db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
		LogActivity(db, user.ID, "DELETE_TASK", "TASK", id, taskTitle, "", c.ClientIP(), getRequestSource(c))

		taskService := services.NewTaskService(db)
		if err := taskService.DeleteTask(id); err != nil {
			errMsg := fmt.Sprintf("Failed to delete task: %v", err)
			LogActivity(db, user.ID, "DELETE_TASK", "TASK", id, taskTitle, errMsg, c.ClientIP(), getRequestSource(c))
			c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
			return
		}

		broadcast()
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
