package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

// broadcast sends a refresh message to WebSocket server
func broadcast() {
	// Broadcast refresh to all connected WebSocket clients
	BroadcastRefresh()
}

// GetTasks returns tasks for a column with pagination
func GetTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		columnID := c.Query("columnId")

		// Verify column access if columnID specified
		if columnID != "" {
			boardID, err := getBoardIDForColumn(db, columnID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无效的列 ID"})
				return
			}
			if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "无权访问该列"})
				return
			}
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
		offset := (page - 1) * pageSize

		var total int
		var countQuery string
		var countArgs []interface{}
		if columnID != "" {
			countQuery = "SELECT COUNT(*) FROM tasks WHERE column_id = ?"
			countArgs = []interface{}{columnID}
		} else {
			countQuery = "SELECT COUNT(*) FROM tasks"
			countArgs = []interface{}{}
		}
		if err := db.QueryRow(countQuery, countArgs...).Scan(&total); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		var rows *sql.Rows
		var err error
		if columnID != "" {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at
				FROM tasks
				WHERE column_id = ?
				ORDER BY position ASC
				LIMIT ? OFFSET ?
			`, columnID, pageSize, offset)
		} else {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at
				FROM tasks
				ORDER BY position ASC
				LIMIT ? OFFSET ?
			`, pageSize, offset)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}
		defer rows.Close()

		var tasks []gin.H
		for rows.Next() {
			var task models.Task
			var desc, assignee, meta, createdBy sql.NullString
			var archivedAt sql.NullTime
			if err := rows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &createdBy, &task.CreatedAt, &task.UpdatedAt); err == nil {
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
					"position":    task.Position,
					"published":   task.Published,
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

		pageCount := total / pageSize
		if total%pageSize != 0 {
			pageCount++
		}

		c.JSON(http.StatusOK, gin.H{
			"data":      tasks,
			"total":     total,
			"page":      page,
			"pageSize":  pageSize,
			"pageCount": pageCount,
		})
	}
}

// CreateTaskRequest represents task creation request
type CreateTaskRequest struct {
	Title       string      `json:"title"`
	Description *string     `json:"description"`
	Priority    string      `json:"priority"`
	Assignee    *string     `json:"assignee"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId"`
	Position    int         `json:"position"`
	Published   bool        `json:"published"`
}

// CreateTask creates a new task
func CreateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// VIEWER cannot create tasks
		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法创建任务"})
			return
		}

		if !checkRateLimit("task:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}

		var req CreateTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务标题不能为空"})
			return
		}

		if req.ColumnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForColumn(db, req.ColumnID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的列 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权在该列创建任务"})
			return
		}

		taskID, err := generateTaskID(db, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "生成任务ID失败"})
			return
		}
		now := time.Now()
		priority := req.Priority
		if priority == "" {
			priority = "medium"
		}

		// Handle meta
		var metaStr *string
		if req.Meta != nil {
			metaJSON, _ := json.Marshal(req.Meta)
			s := string(metaJSON)
			metaStr = &s
		}

		_, err = db.Exec(`
			INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, taskID, req.Title, req.Description, priority, req.Assignee, metaStr, req.ColumnID, req.Position, req.Published, false, user.ID, now, now)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建任务失败"})
			return
		}

		LogActivity(db, user.ID, "CREATE_TASK", "TASK", taskID, req.Title, "", c.ClientIP(), getRequestSource(c))

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":          taskID,
			"title":       req.Title,
			"description": req.Description,
			"priority":    priority,
			"assignee":    req.Assignee,
			"meta":        metaStr,
			"columnId":    req.ColumnID,
			"position":    req.Position,
			"published":   req.Published,
			"archived":    false,
			"createdBy":   user.ID,
			"createdAt":   now,
			"updatedAt":   now,
			"comments":    []gin.H{},
		})
	}
}

// GetTask returns a single task
func GetTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权访问该任务"})
			return
		}

		var task models.Task
		var desc, assignee, meta, createdBy sql.NullString
		var archivedAt sql.NullTime
		err = db.QueryRow(`
			SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at
			FROM tasks
			WHERE id = ?
		`, id).Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &createdBy, &task.CreatedAt, &task.UpdatedAt)

		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

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
		if createdBy.Valid {
			task.CreatedBy = createdBy.String
		}

		comments, _ := getCommentsForTask(db, task.ID)
		subtasks, _ := getSubtasksForTask(db, task.ID)

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

// UpdateTaskRequest represents task update request
type UpdateTaskRequest struct {
	Title       string      `json:"title"`
	Description *string     `json:"description"`
	Priority    string      `json:"priority"`
	Assignee    *string     `json:"assignee"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId"`
	Position    *int        `json:"position"`
	Published   *bool       `json:"published"`
}

// UpdateTask updates a task
func UpdateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// VIEWER cannot update tasks
		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法修改任务"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		// Check board access first
		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权修改该任务"})
			return
		}

		// For MEMBER role, check if they own the task
		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "只能修改自己创建的任务"})
				return
			}
		}

		var req UpdateTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		var oldTask struct {
			Title       string
			Description *string
			Priority    string
			Assignee    *string
			Meta        *string
			ColumnID    string
			Position    int
			Published   bool
		}
		db.QueryRow("SELECT title, description, priority, assignee, meta, column_id, position, published FROM tasks WHERE id = ?", id).Scan(&oldTask.Title, &oldTask.Description, &oldTask.Priority, &oldTask.Assignee, &oldTask.Meta, &oldTask.ColumnID, &oldTask.Position, &oldTask.Published)

		var changes []string

		if req.Title != "" && req.Title != oldTask.Title {
			changes = append(changes, fmt.Sprintf("标题: '%s' → '%s'", oldTask.Title, req.Title))
		}
		if req.Description != nil {
			oldDesc := ""
			if oldTask.Description != nil {
				oldDesc = *oldTask.Description
			}
			if *req.Description != oldDesc {
				changes = append(changes, fmt.Sprintf("描述: '%s' → '%s'", oldDesc, *req.Description))
			}
		}
		if req.Priority != "" && req.Priority != oldTask.Priority {
			changes = append(changes, fmt.Sprintf("优先级: '%s' → '%s'", oldTask.Priority, req.Priority))
		}
		if req.Assignee != nil {
			oldAssignee := ""
			if oldTask.Assignee != nil {
				oldAssignee = *oldTask.Assignee
			}
			if *req.Assignee != oldAssignee {
				changes = append(changes, fmt.Sprintf("负责人: '%s' → '%s'", oldAssignee, *req.Assignee))
			}
		}
		if req.Meta != nil {
			oldMeta := ""
			if oldTask.Meta != nil {
				oldMeta = *oldTask.Meta
			}
			newMeta, _ := json.Marshal(req.Meta)
			if string(newMeta) != oldMeta {
				changes = append(changes, fmt.Sprintf("元数据: '%s' → '%s'", oldMeta, string(newMeta)))
			}
		}
		if req.ColumnID != "" && req.ColumnID != oldTask.ColumnID {
			var oldStatus, newStatus sql.NullString
			db.QueryRow("SELECT status FROM columns WHERE id = ?", oldTask.ColumnID).Scan(&oldStatus)
			db.QueryRow("SELECT status FROM columns WHERE id = ?", req.ColumnID).Scan(&newStatus)
			oldStatusVal := ""
			if oldStatus.Valid {
				oldStatusVal = oldStatus.String
			}
			newStatusVal := ""
			if newStatus.Valid {
				newStatusVal = newStatus.String
			}
			if oldStatusVal != "" || newStatusVal != "" {
				changes = append(changes, fmt.Sprintf("状态: '%s' → '%s'", oldStatusVal, newStatusVal))
			}
		}
		if req.Position != nil && *req.Position != oldTask.Position {
			changes = append(changes, fmt.Sprintf("位置: %d → %d", oldTask.Position, *req.Position))
		}
		if req.Published != nil && *req.Published != oldTask.Published {
			oldPub := "否"
			if oldTask.Published {
				oldPub = "是"
			}
			newPub := "否"
			if *req.Published {
				newPub = "是"
			}
			changes = append(changes, fmt.Sprintf("发布: %s → %s", oldPub, newPub))
		}

		details := ""
		if len(changes) > 0 {
			details = strings.Join(changes, ", ")
		}

		updates := []interface{}{time.Now()}
		query := "UPDATE tasks SET updated_at = ?"

		if req.Title != "" {
			query += ", title = ?"
			updates = append(updates, req.Title)
		}
		if req.Description != nil {
			query += ", description = ?"
			updates = append(updates, *req.Description)
		}
		if req.Priority != "" {
			query += ", priority = ?"
			updates = append(updates, req.Priority)
		}
		if req.Assignee != nil {
			query += ", assignee = ?"
			updates = append(updates, *req.Assignee)
		}
		if req.Meta != nil {
			metaJSON, _ := json.Marshal(req.Meta)
			query += ", meta = ?"
			updates = append(updates, string(metaJSON))
		}
		if req.ColumnID != "" {
			query += ", column_id = ?"
			updates = append(updates, req.ColumnID)
		}
		if req.Position != nil {
			query += ", position = ?"
			updates = append(updates, *req.Position)
		}
		if req.Published != nil {
			query += ", published = ?"
			updates = append(updates, *req.Published)
		}

		query += " WHERE id = ?"
		updates = append(updates, id)

		_, err = db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		var taskTitle string
		db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
		LogActivity(db, user.ID, "UPDATE_TASK", "TASK", id, taskTitle, details, c.ClientIP(), getRequestSource(c))

		broadcast()

		// Get updated task
		GetTask(db)(c)
	}
}

// DeleteTask deletes a task
func DeleteTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// VIEWER cannot delete tasks
		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法删除任务"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		// ADMIN can delete any task, MEMBER can only delete their own
		if user.Role == "MEMBER" {
			var createdBy sql.NullString
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil {
				if err == sql.ErrNoRows {
					c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
					return
				}
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("查询任务失败: %v", err)})
				return
			}
			if !createdBy.Valid || createdBy.String != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "只能删除自己创建的任务"})
				return
			}
		} else if !checkBoardAccess(db, user.ID, boardID, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权删除该任务"})
			return
		}

		var taskTitle string
		db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
		LogActivity(db, user.ID, "DELETE_TASK", "TASK", id, taskTitle, "", c.ClientIP(), getRequestSource(c))

		_, err = db.Exec("DELETE FROM tasks WHERE id = ?", id)
		if err != nil {
			errMsg := fmt.Sprintf("删除任务失败: %v", err)
			LogActivity(db, user.ID, "DELETE_TASK", "TASK", id, taskTitle, errMsg, c.ClientIP(), getRequestSource(c))
			c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
			return
		}

		broadcast()
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// ArchiveTaskRequest represents archive request
type ArchiveTaskRequest struct {
	Archived *bool `json:"archived"`
}

// ArchiveTask archives or unarchives a task
func ArchiveTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// VIEWER cannot archive tasks
		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法归档任务"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		// Check board access
		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权归档该任务"})
			return
		}

		// For MEMBER role, check if they own the task
		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "只能归档自己创建的任务"})
				return
			}
		}

		var req ArchiveTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		archived := true
		if req.Archived != nil {
			archived = *req.Archived
		}

		var archivedAt interface{}
		if archived {
			archivedAt = time.Now()
		} else {
			archivedAt = nil
		}

		now := time.Now()
		_, err = db.Exec(
			"UPDATE tasks SET archived = ?, archived_at = ?, updated_at = ? WHERE id = ?",
			archived, archivedAt, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "归档失败"})
			return
		}

		if archived {
			var taskTitle string
			db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
			LogActivity(db, user.ID, "COMPLETE_TASK", "TASK", id, taskTitle, "", c.ClientIP(), getRequestSource(c))
		}

		broadcast()

		// Get updated task
		GetTask(db)(c)
	}
}

// GetMyTasks returns tasks assigned to the current agent or in columns configured for the agent's type
func GetMyTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// Get the token's userAgent (agent type)
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
			// Fallback: use user's nickname as assignee identifier
			userAgent = ""
		}

		// Get all columns with their agent configs
		rows, err := db.Query(`
			SELECT c.id, c.name, c.board_id, COALESCE(ca.agent_types, '[]') as agent_types
			FROM columns c
			LEFT JOIN column_agents ca ON c.id = ca.column_id
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取列信息失败"})
			return
		}
		defer rows.Close()

		// Build a map of column IDs that this agent can handle
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

		// Get tasks where assignee matches user's nickname OR column is in the allowed list
		var tasks []gin.H
		var taskRows *sql.Rows

		if userAgent != "" && len(columnIDs) > 0 {
			// Build placeholders for IN clause
			placeholders := make([]string, len(columnIDs))
			args := make([]interface{}, 0, len(columnIDs)+1)
			i := 0
			for colID := range columnIDs {
				placeholders[i] = "?"
				args = append(args, colID)
				i++
			}
			args = append(args, user.Nickname)

			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND (t.assignee = ? OR t.column_id IN (%s))
				ORDER BY t.position ASC, t.created_at ASC
			`, strings.Join(placeholders, ","))

			taskRows, err = db.Query(query, args...)
		} else if userAgent != "" {
			// Only assignee match, no column configs
			taskRows, err = db.Query(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.assignee = ?
				ORDER BY t.position ASC, t.created_at ASC
			`, user.Nickname)
		} else if len(columnIDs) > 0 {
			// Only column match, no userAgent
			placeholders := make([]string, len(columnIDs))
			args := make([]interface{}, 0, len(columnIDs))
			i := 0
			for colID := range columnIDs {
				placeholders[i] = "?"
				args = append(args, colID)
				i++
			}

			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.column_id IN (%s)
				ORDER BY t.position ASC, t.created_at ASC
			`, strings.Join(placeholders, ","))

			taskRows, err = db.Query(query, args...)
		} else {
			// No userAgent and no column configs - return empty
			tasks = []gin.H{}
		}

		if err != nil && tasks == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		if taskRows != nil {
			defer taskRows.Close()
			for taskRows.Next() {
				var task models.Task
				var desc, assignee, meta, createdBy, columnName sql.NullString
				var archivedAt sql.NullTime
				if err := taskRows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &createdBy, &task.CreatedAt, &task.UpdatedAt, &columnName); err == nil {
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

// CompleteTask moves a task to the next column (for workflow progression)
func CompleteTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		// VIEWER cannot complete tasks
		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法完成任务"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		// Get task's current column and board
		boardID, err := getBoardIDForTask(db, id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		// Check board access
		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权操作该任务"})
			return
		}

		// For MEMBER role, check if they own the task
		if user.Role == "MEMBER" {
			var createdBy string
			err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", id).Scan(&createdBy)
			if err != nil || createdBy != user.ID {
				c.JSON(http.StatusForbidden, gin.H{"error": "只能完成自己创建的任务"})
				return
			}
		}

		// Get task's current column
		var currentColumnID string
		err = db.QueryRow("SELECT column_id FROM tasks WHERE id = ?", id).Scan(&currentColumnID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}

		// Get current column's position
		var currentPosition int
		err = db.QueryRow("SELECT position FROM columns WHERE id = ?", currentColumnID).Scan(&currentPosition)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取列信息失败"})
			return
		}

		// Get all columns for this board ordered by position
		rows, err := db.Query(
			"SELECT id, position FROM columns WHERE board_id = ? ORDER BY position ASC",
			boardID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取列信息失败"})
			return
		}
		defer rows.Close()

		var nextColumnID string
		for rows.Next() {
			var colID string
			var position int
			if err := rows.Scan(&colID, &position); err == nil {
				if position > currentPosition {
					nextColumnID = colID
					break
				}
			}
		}

		if nextColumnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务已在最后一列"})
			return
		}

		// Update task to next column
		now := time.Now()
		_, err = db.Exec(
			"UPDATE tasks SET column_id = ?, updated_at = ? WHERE id = ?",
			nextColumnID, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新任务失败"})
			return
		}

		// Log activity
		var taskTitle string
		db.QueryRow("SELECT title FROM tasks WHERE id = ?", id).Scan(&taskTitle)
		var oldStatus, newStatus sql.NullString
		db.QueryRow("SELECT status FROM columns WHERE id = ?", currentColumnID).Scan(&oldStatus)
		db.QueryRow("SELECT status FROM columns WHERE id = ?", nextColumnID).Scan(&newStatus)
		oldStatusVal := ""
		if oldStatus.Valid {
			oldStatusVal = oldStatus.String
		}
		newStatusVal := ""
		if newStatus.Valid {
			newStatusVal = newStatus.String
		}
		details := fmt.Sprintf("状态: '%s' → '%s'", oldStatusVal, newStatusVal)
		LogActivity(db, user.ID, "UPDATE_TASK", "TASK", id, taskTitle, details, c.ClientIP(), getRequestSource(c))

		broadcast()

		// Get updated task
		GetTask(db)(c)
	}
}

func generateTaskID(db *sql.DB, boardID string) (string, error) {
	var shortAlias string
	err := db.QueryRow("SELECT short_alias FROM boards WHERE id = ?", boardID).Scan(&shortAlias)
	if err != nil {
		return "", err
	}

	tx, err := db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	var counter int
	err = tx.QueryRow("SELECT task_counter FROM boards WHERE id = ? FOR UPDATE", boardID).Scan(&counter)
	if err != nil {
		return "", err
	}

	counter++
	newCounter := counter

	digits := 4
	if newCounter >= 10000 {
		digits = 6
	}
	if newCounter >= 1000000 {
		digits = 8
	}

	_, err = tx.Exec("UPDATE boards SET task_counter = ? WHERE id = ?", newCounter, boardID)
	if err != nil {
		return "", err
	}

	err = tx.Commit()
	if err != nil {
		return "", err
	}

	taskID := fmt.Sprintf("%s-%0*d", shortAlias, digits, newCounter)
	return taskID, nil
}
