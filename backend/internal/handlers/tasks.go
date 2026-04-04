package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"open-kanban/internal/models"
	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func broadcast() {
	BroadcastRefresh()
}

func GetTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		columnID := c.Query("columnId")
		boardID := c.Query("boardId")
		status := c.Query("status")

		if columnID != "" && !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "READ", user.Role) {
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

		taskService := services.NewTaskService(db)
		result, err := taskService.GetTasks(user.ID, user.Role, columnID, boardID, status, page, pageSize)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get task: " + err.Error()})
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

type CreateTaskRequest struct {
	Title       string      `json:"title" validate:"required,max=500"`
	Description *string     `json:"description" validate:"omitempty,max=5000"`
	Priority    string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee    *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId" validate:"required"`
	Position    int         `json:"position"`
	Published   bool        `json:"published"`
	AgentID     *string     `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string     `json:"agentPrompt" validate:"omitempty,max=2000"`
}

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

func GetTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
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

		if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this task"})
			return
		}

		include := c.Query("include")

		taskService := services.NewTaskService(db)
		task, commentCount, subtaskCount, err := taskService.GetTask(id, user.ID, user.Role)
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

type UpdateTaskRequest struct {
	Title       string      `json:"title" validate:"omitempty,required,max=500"`
	Description *string     `json:"description" validate:"omitempty,max=5000"`
	Priority    string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee    *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId" validate:"omitempty,uuid"`
	Position    *int        `json:"position"`
	Published   *bool       `json:"published"`
	AgentID     *string     `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string     `json:"agentPrompt" validate:"omitempty,max=2000"`
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

type ArchiveTaskRequest struct {
	Archived *bool `json:"archived"`
}

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
			db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
			LogActivity(db, user.ID, "COMPLETE_TASK", "TASK", id, taskTitle, "", c.ClientIP(), getRequestSource(c))
		}

		broadcast()
		GetTask(db)(c)
	}
}

func GetMyTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var tokenKey string
		if authHeader := c.GetHeader("Authorization"); authHeader != "" {
			if strings.HasPrefix(authHeader, "Bearer ") {
				tokenKey = strings.TrimPrefix(authHeader, "Bearer ")
			}
		}
		if tokenKey == "" {
			tokenKey, _ = c.Cookie("kanban-token")
		}

		var userAgent string
		err := db.QueryRow("SELECT user_agent FROM tokens WHERE `key` = ?", tokenKey).Scan(&userAgent)
		if err != nil {
			userAgent = ""
		}

		rows, err := db.Query(`
			SELECT c.id, c.name, c.board_id, COALESCE(ca.agent_types, '[]') as agent_types
			FROM columns c
			LEFT JOIN column_agents ca ON c.id = ca.column_id
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column info"})
			return
		}
		defer rows.Close()

		columnIDs := make(map[string]bool)
		for rows.Next() {
			var colID, colName, boardID, agentTypesStr string
			if err := rows.Scan(&colID, &colName, &boardID, &agentTypesStr); err == nil {
				if userAgent != "" && agentTypesStr != "" && agentTypesStr != "[]" {
					var agentTypes []string
					json.Unmarshal([]byte(agentTypesStr), &agentTypes)
					for _, at := range agentTypes {
						if at == userAgent {
							columnIDs[colID] = true
							break
						}
					}
				}
			}
		}

		var tasks []gin.H
		var taskRows *sql.Rows

		if userAgent != "" && len(columnIDs) > 0 {
			args := make([]interface{}, 0, len(columnIDs)+1)
			for colID := range columnIDs {
				args = append(args, colID)
			}
			args = append(args, user.Nickname)

			inClause := buildInClause(len(columnIDs))
			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND (t.assignee = ? OR t.column_id IN %s)
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, inClause)

			taskRows, err = db.Query(query, args...)
		} else if userAgent != "" {
			taskRows, err = db.Query(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.assignee = ?
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, user.Nickname)
		} else if len(columnIDs) > 0 {
			args := make([]interface{}, 0, len(columnIDs))
			for colID := range columnIDs {
				args = append(args, colID)
			}

			inClause := buildInClause(len(columnIDs))
			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.column_id IN %s
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, inClause)

			taskRows, err = db.Query(query, args...)
		} else {
			tasks = []gin.H{}
		}

		if err != nil && tasks == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get tasks"})
			return
		}

		if taskRows != nil {
			defer taskRows.Close()
			for taskRows.Next() {
				var task models.Task
				var desc, assignee, meta, createdBy, columnName, agentID, agentPrompt sql.NullString
				var archivedAt sql.NullTime
				if err := taskRows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt, &columnName); err == nil {
					if desc.Valid {
						task.Description = &desc.String
					}
					if assignee.Valid {
						task.Assignee = &assignee.String
					}
					if meta.Valid {
						task.Meta = &meta.String
					}
					if archivedAt.Valid {
						task.ArchivedAt = &archivedAt.Time
					}
					if agentID.Valid {
						task.AgentID = &agentID.String
					}
					if agentPrompt.Valid {
						task.AgentPrompt = &agentPrompt.String
					}
					if createdBy.Valid {
						task.CreatedBy = createdBy.String
					}

					comments, _ := getCommentsForTask(db, task.ID)
					subtasks, _ := getSubtasksForTask(db, task.ID)

					tasks = append(tasks, gin.H{
						"id":          task.ID,
						"title":       task.Title,
						"description": task.Description,
						"priority":    task.Priority,
						"assignee":    task.Assignee,
						"meta":        task.Meta,
						"columnId":    task.ColumnID,
						"columnName":  columnName.String,
						"position":    task.Position,
						"published":   task.Published,
						"agentId":     task.AgentID,
						"agentPrompt": task.AgentPrompt,
						"archived":    task.Archived,
						"archivedAt":  task.ArchivedAt,
						"createdBy":   task.CreatedBy,
						"createdAt":   task.CreatedAt,
						"updatedAt":   task.UpdatedAt,
						"comments":    comments,
						"subtasks":    subtasks,
					})
				}
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"tasks":     tasks,
			"total":     len(tasks),
			"userAgent": userAgent,
		})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var taskTitle string
		db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
		var oldStatus, newStatus sql.NullString
		db.QueryRow("SELECT status FROM columns WHERE id = ?", columnID).Scan(&oldStatus)

		newColumnID, _ := getColumnIDForTask(db, id)
		db.QueryRow("SELECT status FROM columns WHERE id = ?", newColumnID).Scan(&newStatus)

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
	}
}

func getColumnIDForTask(db *sql.DB, taskID string) (string, error) {
	var columnID string
	err := db.QueryRow("SELECT column_id FROM tasks WHERE id = ?", taskID).Scan(&columnID)
	return columnID, err
}
