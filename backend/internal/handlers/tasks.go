package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

// broadcast sends a refresh message to WebSocket server
func broadcast() {
	// Broadcast refresh to all connected WebSocket clients
	BroadcastRefresh()
}

// GetTasks returns tasks for a column
func GetTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		columnID := c.Query("columnId")

		var rows *sql.Rows
		var err error
		if columnID != "" {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				WHERE column_id = ?
				ORDER BY position ASC
			`, columnID)
		} else {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				ORDER BY position ASC
			`)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取任务失败"})
			return
		}
		defer rows.Close()

		var tasks []gin.H
		for rows.Next() {
			var task models.Task
			var desc, assignee, meta sql.NullString
			var archivedAt sql.NullTime
			if err := rows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &task.CreatedAt, &task.UpdatedAt); err == nil {
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

				// Get comments
				comments, _ := getCommentsForTask(db, task.ID)
				// Get subtasks
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
					"createdAt":   task.CreatedAt,
					"updatedAt":   task.UpdatedAt,
					"comments":    comments,
					"subtasks":    subtasks,
				})
			}
		}

		c.JSON(http.StatusOK, tasks)
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
		var req CreateTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务标题不能为空"})
			return
		}

		taskID := generateID()
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

		_, err := db.Exec(`
			INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, taskID, req.Title, req.Description, priority, req.Assignee, metaStr, req.ColumnID, req.Position, req.Published, false, now, now)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建任务失败"})
			return
		}

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
			"createdAt":   now,
			"updatedAt":   now,
			"comments":    []gin.H{},
		})
	}
}

// GetTask returns a single task
func GetTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		var task models.Task
		var desc, assignee, meta sql.NullString
		var archivedAt sql.NullTime
		err := db.QueryRow(`
			SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
			FROM tasks
			WHERE id = ?
		`, id).Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &task.CreatedAt, &task.UpdatedAt)

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

		// Get comments
		comments, _ := getCommentsForTask(db, task.ID)
		// Get subtasks
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
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		var req UpdateTaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
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

		_, err := db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		broadcast()

		// Get updated task
		GetTask(db)(c)
	}
}

// DeleteTask deletes a task
func DeleteTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		_, err := db.Exec("DELETE FROM tasks WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
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
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
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
		_, err := db.Exec(
			"UPDATE tasks SET archived = ?, archived_at = ?, updated_at = ? WHERE id = ?",
			archived, archivedAt, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "归档失败"})
			return
		}

		broadcast()

		// Get updated task
		GetTask(db)(c)
	}
}
