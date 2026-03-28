package handlers

import (
	"database/sql"
	"net/http"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

// GetArchivedTasks returns archived tasks for a board
func GetArchivedTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		boardID := c.Query("boardId")

		// Get column IDs for the board
		var columnIDs []string
		if boardID != "" {
			rows, err := db.Query("SELECT id FROM columns WHERE board_id = ?", boardID)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var colID string
					if err := rows.Scan(&colID); err == nil {
						columnIDs = append(columnIDs, colID)
					}
				}
			}
		}

		// Build query
		var rows *sql.Rows
		var err error
		if len(columnIDs) > 0 {
			// Use IN clause
			query := `
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				WHERE archived = true AND column_id IN (?
			`
			// Build placeholders
			placeholders := make([]interface{}, len(columnIDs))
			for i, id := range columnIDs {
				placeholders[i] = id
				if i > 0 {
					query += ",?"
				}
			}
			query += `) ORDER BY archived_at DESC`
			rows, err = db.Query(query, placeholders...)
		} else {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				WHERE archived = true
				ORDER BY archived_at DESC
			`)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取归档任务失败"})
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

// GetDrafts returns draft (unpublished) tasks for a board
func GetDrafts(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		boardID := c.Query("boardId")

		// Get column IDs for the board
		var columnIDs []string
		if boardID != "" {
			rows, err := db.Query("SELECT id FROM columns WHERE board_id = ?", boardID)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var colID string
					if err := rows.Scan(&colID); err == nil {
						columnIDs = append(columnIDs, colID)
					}
				}
			}
		}

		// Build query
		var rows *sql.Rows
		var err error
		if len(columnIDs) > 0 {
			// Use IN clause
			query := `
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				WHERE published = false AND archived = false AND column_id IN (?
			`
			// Build placeholders
			placeholders := make([]interface{}, len(columnIDs))
			for i, id := range columnIDs {
				placeholders[i] = id
				if i > 0 {
					query += ",?"
				}
			}
			query += `) ORDER BY created_at DESC`
			rows, err = db.Query(query, placeholders...)
		} else {
			rows, err = db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks
				WHERE published = false AND archived = false
				ORDER BY created_at DESC
			`)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取草稿失败"})
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
