package handlers

import (
	"database/sql"
	"net/http"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

type BatchUpdateTasksRequest struct {
	IDs      []string `json:"ids" validate:"required,min=1"`
	ColumnID string   `json:"columnId,omitempty"`
	Status   string   `json:"status,omitempty" validate:"omitempty,oneof=todo in_progress testing review done"`
	Priority string   `json:"priority,omitempty" validate:"omitempty,oneof=low medium high"`
	Assignee *string  `json:"assignee,omitempty"`
}

func BatchUpdateTasks(db *sql.DB) gin.HandlerFunc {
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

		var req BatchUpdateTasksRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if len(req.IDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ids are required"})
			return
		}

		if req.ColumnID == "" && req.Status == "" && req.Priority == "" && req.Assignee == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "at least one update field is required (columnId, status, priority, or assignee)"})
			return
		}

		var targetColumnID string
		if req.ColumnID != "" {
			targetColumnID = req.ColumnID
		} else if req.Status != "" {
			allColumns, err := getAllColumns(db)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get columns"})
				return
			}
			statusMap := map[string]string{
				"todo":        "待办",
				"in_progress": "进行中",
				"testing":     "待测试",
				"review":      "待审核",
				"done":        "已完成",
			}
			columnName := statusMap[req.Status]
			if columnName == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid status"})
				return
			}
			for _, col := range allColumns {
				if col.Name == columnName {
					targetColumnID = col.ID
					break
				}
			}
			if targetColumnID == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "column not found for status"})
				return
			}
		}

		if targetColumnID != "" {
			if !checkColumnAccessWithBoardFallback(db, user.ID, targetColumnID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to move tasks to this column"})
				return
			}
		}

		taskService := services.NewTaskService(db)

		updated := 0
		failed := 0
		var errors []string

		for _, taskID := range req.IDs {
			columnID, err := getColumnIDForTask(db, taskID)
			if err != nil {
				failed++
				errors = append(errors, "task "+taskID+": not found")
				continue
			}

			if user.Role == "MEMBER" {
				var createdBy string
				err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", taskID).Scan(&createdBy)
				if err != nil || createdBy != user.ID {
					failed++
					errors = append(errors, "task "+taskID+": can only modify tasks you created")
					continue
				}
			} else if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "WRITE", user.Role) {
				failed++
				errors = append(errors, "task "+taskID+": no permission")
				continue
			}

			updateInput := services.UpdateTaskInput{}
			hasUpdate := false

			if targetColumnID != "" {
				updateInput.ColumnID = targetColumnID
				hasUpdate = true
			}
			if req.Priority != "" {
				updateInput.Priority = req.Priority
				hasUpdate = true
			}
			if req.Assignee != nil {
				updateInput.Assignee = req.Assignee
				hasUpdate = true
			}

			if !hasUpdate {
				continue
			}

			task, _, err := taskService.UpdateTask(taskID, user.ID, user.Role, updateInput)
			if err != nil {
				failed++
				errors = append(errors, "task "+taskID+": "+err.Error())
				continue
			}

			details := ""
			if targetColumnID != "" && targetColumnID != columnID {
				details = "moved to " + targetColumnID
			}
			if req.Priority != "" {
				if details != "" {
					details += ", "
				}
				details += "priority set to " + req.Priority
			}
			LogActivity(db, user.ID, "UPDATE_TASK", "TASK", taskID, task.Title, details, c.ClientIP(), getRequestSource(c))
			updated++
		}

		broadcast()

		result := gin.H{
			"updated": updated,
			"failed":  failed,
		}
		if len(errors) > 0 {
			result["errors"] = errors
		}

		c.JSON(http.StatusOK, result)
	}
}

type columnInfo struct {
	ID      string
	Name    string
	BoardID string
}

type BatchDeleteTasksRequest struct {
	IDs []string `json:"ids" validate:"required,min=1"`
}

func BatchDeleteTasks(db *sql.DB) gin.HandlerFunc {
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

		var req BatchDeleteTasksRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if len(req.IDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ids are required"})
			return
		}

		deleted := 0
		failed := 0
		var errors []string

		for _, taskID := range req.IDs {
			columnID, err := getColumnIDForTask(db, taskID)
			if err != nil {
				failed++
				errors = append(errors, "task "+taskID+": not found")
				continue
			}

			if user.Role == "MEMBER" {
				var createdBy string
				err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", taskID).Scan(&createdBy)
				if err != nil || createdBy != user.ID {
					failed++
					errors = append(errors, "task "+taskID+": can only delete tasks you created")
					continue
				}
			} else if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "WRITE", user.Role) {
				failed++
				errors = append(errors, "task "+taskID+": no permission")
				continue
			}

			_, err = db.Exec("DELETE FROM tasks WHERE id = ?", taskID)
			if err != nil {
				failed++
				errors = append(errors, "task "+taskID+": "+err.Error())
				continue
			}

			LogActivity(db, user.ID, "DELETE_TASK", "TASK", taskID, "", "", c.ClientIP(), getRequestSource(c))
			deleted++
		}

		broadcast()

		result := gin.H{
			"deleted": deleted,
			"failed":  failed,
		}
		if len(errors) > 0 {
			result["errors"] = errors
		}

		c.JSON(http.StatusOK, result)
	}
}

type BatchCreateTasksRequest struct {
	Tasks []CreateTaskRequest `json:"tasks" validate:"required,min=1,dive"`
}

func BatchCreateTasks(db *sql.DB) gin.HandlerFunc {
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

		var req BatchCreateTasksRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if len(req.Tasks) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "tasks are required"})
			return
		}

		taskService := services.NewTaskService(db)

		created := 0
		failed := 0
		var errors []string
		var createdTasks []gin.H

		for i, taskReq := range req.Tasks {
			if !checkColumnAccessWithBoardFallback(db, user.ID, taskReq.ColumnID, "WRITE", user.Role) {
				failed++
				errors = append(errors, "task "+string(rune(i))+": no permission to create in column "+taskReq.ColumnID)
				continue
			}

			task, err := taskService.CreateTask(services.CreateTaskInput{
				Title:       taskReq.Title,
				Description: taskReq.Description,
				Priority:    taskReq.Priority,
				Assignee:    taskReq.Assignee,
				Meta:        taskReq.Meta,
				ColumnID:    taskReq.ColumnID,
				Position:    taskReq.Position,
				Published:   taskReq.Published,
				AgentID:     taskReq.AgentID,
				AgentPrompt: taskReq.AgentPrompt,
				CreatedBy:   user.ID,
			})

			if err != nil {
				failed++
				errors = append(errors, "task "+string(rune(i))+": "+err.Error())
				continue
			}

			LogActivity(db, user.ID, "CREATE_TASK", "TASK", task.ID, task.Title, "", c.ClientIP(), getRequestSource(c))
			created++
			createdTasks = append(createdTasks, gin.H{
				"id":    task.ID,
				"title": task.Title,
			})
		}

		broadcast()

		result := gin.H{
			"created": created,
			"failed":  failed,
		}
		if len(errors) > 0 {
			result["errors"] = errors
		}
		if len(createdTasks) > 0 {
			result["tasks"] = createdTasks
		}

		c.JSON(http.StatusOK, result)
	}
}

func getAllColumns(db *sql.DB) ([]columnInfo, error) {
	rows, err := db.Query("SELECT id, name, board_id FROM columns")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []columnInfo
	for rows.Next() {
		var col columnInfo
		if err := rows.Scan(&col.ID, &col.Name, &col.BoardID); err != nil {
			continue
		}
		columns = append(columns, col)
	}
	return columns, nil
}
