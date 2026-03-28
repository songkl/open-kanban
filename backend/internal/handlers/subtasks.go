package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

// GetSubtasks returns subtasks for a task
func GetSubtasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		taskID := c.Query("taskId")

		var rows *sql.Rows
		var err error
		if taskID != "" {
			rows, err = db.Query(`
				SELECT id, title, completed, task_id, created_at, updated_at
				FROM subtasks
				WHERE task_id = ?
				ORDER BY created_at ASC
			`, taskID)
		} else {
			rows, err = db.Query(`
				SELECT id, title, completed, task_id, created_at, updated_at
				FROM subtasks
				ORDER BY created_at ASC
			`)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取子任务失败"})
			return
		}
		defer rows.Close()

		var subtasks []gin.H
		for rows.Next() {
			var st models.Subtask
			if err := rows.Scan(&st.ID, &st.Title, &st.Completed, &st.TaskID, &st.CreatedAt, &st.UpdatedAt); err == nil {
				subtasks = append(subtasks, gin.H{
					"id":        st.ID,
					"title":     st.Title,
					"completed": st.Completed,
					"taskId":    st.TaskID,
					"createdAt": st.CreatedAt,
					"updatedAt": st.UpdatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, subtasks)
	}
}

// CreateSubtaskRequest represents subtask creation request
type CreateSubtaskRequest struct {
	Title  string `json:"title"`
	TaskID string `json:"taskId"`
}

// CreateSubtask creates a new subtask
func CreateSubtask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CreateSubtaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "子任务标题不能为空"})
			return
		}

		subtaskID := generateID()
		now := time.Now()

		_, err := db.Exec(
			"INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			subtaskID, req.Title, false, req.TaskID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建子任务失败"})
			return
		}

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":        subtaskID,
			"title":     req.Title,
			"completed": false,
			"taskId":    req.TaskID,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}

// UpdateSubtaskRequest represents subtask update request
type UpdateSubtaskRequest struct {
	Title     *string `json:"title"`
	Completed *bool   `json:"completed"`
}

// UpdateSubtask updates a subtask
func UpdateSubtask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "子任务 ID 不能为空"})
			return
		}

		var req UpdateSubtaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		updates := []interface{}{time.Now()}
		query := "UPDATE subtasks SET updated_at = ?"

		if req.Title != nil {
			query += ", title = ?"
			updates = append(updates, *req.Title)
		}
		if req.Completed != nil {
			query += ", completed = ?"
			updates = append(updates, *req.Completed)
		}

		query += " WHERE id = ?"
		updates = append(updates, id)

		_, err := db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		broadcast()

		// Get updated subtask
		var st models.Subtask
		err = db.QueryRow(`
			SELECT id, title, completed, task_id, created_at, updated_at
			FROM subtasks
			WHERE id = ?
		`, id).Scan(&st.ID, &st.Title, &st.Completed, &st.TaskID, &st.CreatedAt, &st.UpdatedAt)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取子任务失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":        st.ID,
			"title":     st.Title,
			"completed": st.Completed,
			"taskId":    st.TaskID,
			"createdAt": st.CreatedAt,
			"updatedAt": st.UpdatedAt,
		})
	}
}

// DeleteSubtask deletes a subtask
func DeleteSubtask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "子任务 ID 不能为空"})
			return
		}

		_, err := db.Exec("DELETE FROM subtasks WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		broadcast()
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
