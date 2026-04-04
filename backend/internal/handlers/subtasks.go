package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

// GetSubtasks returns subtasks for a task
func GetSubtasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		taskID := c.Query("taskId")

		if taskID != "" {
			boardID, err := getBoardIDForTask(db, taskID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task ID"})
				return
			}

			if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to view subtasks of this task"})
				return
			}
		}

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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get subtasks"})
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
	Title  string `json:"title" validate:"required,max=500"`
	TaskID string `json:"taskId" validate:"required"`
}

// CreateSubtask creates a new subtask
func CreateSubtask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot create subtasks"})
			return
		}

		var req CreateSubtaskRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		boardID, err := getBoardIDForTask(db, req.TaskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to create subtask in this task"})
			return
		}

		subtaskID := generateID()
		now := time.Now()

		_, err = db.Exec(
			"INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			subtaskID, req.Title, false, req.TaskID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create subtask"})
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
	Title     *string `json:"title" validate:"omitempty,max=500"`
	Completed *bool   `json:"completed"`
}

// UpdateSubtask updates a subtask
func UpdateSubtask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot modify subtasks"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Subtask ID is required"})
			return
		}

		var taskID string
		err := db.QueryRow("SELECT task_id FROM subtasks WHERE id = ?", id).Scan(&taskID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Subtask not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get subtasks"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get task"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this subtask"})
			return
		}

		var req UpdateSubtaskRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
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

		_, err = db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get subtasks"})
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
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot delete subtasks"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Subtask ID is required"})
			return
		}

		var taskID string
		err := db.QueryRow("SELECT task_id FROM subtasks WHERE id = ?", id).Scan(&taskID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Subtask not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get subtasks"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get task"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this subtask"})
			return
		}

		_, err = db.Exec("DELETE FROM subtasks WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		broadcast()
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
