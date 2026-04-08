package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func broadcast() {
	BroadcastRefresh()
}

func GetTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)

		columnID := c.Query("columnId")
		boardID := c.Query("boardId")
		status := c.Query("status")
		includeDrafts := c.Query("includeDrafts") == "true"
		includeArchived := c.Query("includeArchived") == "true"

		if columnID != "" && user != nil && !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this column"})
			return
		}

		page := 1
		pageSize := 20
		if p := c.Query("page"); p != "" {
			if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
				page = parsed
			}
		}
		if ps := c.Query("pageSize"); ps != "" {
			if parsed, err := strconv.Atoi(ps); err == nil && parsed > 0 && parsed <= 100 {
				pageSize = parsed
			}
		}

		userID := ""
		role := ""
		if user != nil {
			userID = user.ID
			role = user.Role
		}

		taskService := services.NewTaskService(db)
		result, err := taskService.GetTasks(userID, role, columnID, boardID, status, page, pageSize, includeDrafts, includeArchived)
		if err != nil {
			ServerError(c, "Failed to get tasks", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"data":      result.Tasks,
			"total":     result.Total,
			"page":      result.Page,
			"pageSize":  result.PageSize,
			"pageCount": result.PageCount,
		})
	}
}

func GetTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)

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

		if user != nil && !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this task"})
			return
		}

		include := c.Query("include")

		userID := ""
		role := ""
		if user != nil {
			userID = user.ID
			role = user.Role
		}

		taskService := services.NewTaskService(db)
		task, commentCount, subtaskCount, err := taskService.GetTask(id, userID, role)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
			return
		}

		response := gin.H{
			"id":           task.ID,
			"title":        task.Title,
			"description":  task.Description,
			"priority":     task.Priority,
			"assignee":     task.Assignee,
			"meta":         task.Meta,
			"columnId":     task.ColumnID,
			"position":     task.Position,
			"published":    task.Published,
			"archived":     task.Archived,
			"archivedAt":   task.ArchivedAt,
			"agentId":      task.AgentID,
			"agentPrompt":  task.AgentPrompt,
			"createdBy":    task.CreatedBy,
			"createdAt":    task.CreatedAt,
			"updatedAt":    task.UpdatedAt,
			"commentCount": commentCount,
			"subtaskCount": subtaskCount,
		}

		if include != "" {
			includes := strings.Split(include, ",")
			for _, inc := range includes {
				inc = strings.TrimSpace(inc)
				if inc == "comments" {
					comments, _ := getCommentsForTask(db, task.ID)
					response["comments"] = comments
				} else if inc == "subtasks" {
					subtasks, _ := getSubtasksForTask(db, task.ID)
					response["subtasks"] = subtasks
				}
			}
		}

		c.JSON(http.StatusOK, response)
	}
}

func getColumnIDForTask(db *sql.DB, taskID string) (string, error) {
	var columnID string
	err := db.QueryRow("SELECT column_id FROM tasks WHERE id = ?", taskID).Scan(&columnID)
	return columnID, err
}

func getColumnName(db *sql.DB, columnID string) string {
	var name string
	db.QueryRow("SELECT name FROM columns WHERE id = ?", columnID).Scan(&name)
	return name
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func SearchTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		query := c.Query("q")
		priority := c.Query("priority")
		status := c.Query("status")
		boardID := c.Query("boardId")
		assignee := c.Query("assignee")
		dateRange := c.Query("dateRange")
		taskID := c.Query("taskId")

		page := 1
		pageSize := 20
		if p := c.Query("page"); p != "" {
			if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
				page = parsed
			}
		}
		if ps := c.Query("pageSize"); ps != "" {
			if parsed, err := strconv.Atoi(ps); err == nil && parsed > 0 && parsed <= 100 {
				pageSize = parsed
			}
		}

		input := services.SearchTasksInput{
			Query:     query,
			Priority:  priority,
			Status:    status,
			BoardID:   boardID,
			Assignee:  assignee,
			DateRange: dateRange,
			TaskID:    taskID,
			Page:      page,
			PageSize:  pageSize,
		}

		taskService := services.NewTaskService(db)
		result, err := taskService.SearchTasks(input)
		if err != nil {
			ServerError(c, "Failed to search tasks", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"data":      result.Tasks,
			"total":     result.Total,
			"page":      result.Page,
			"pageSize":  result.PageSize,
			"pageCount": result.PageCount,
		})
	}
}
