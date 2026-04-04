package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// GetComments returns comments for a task
func GetComments(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		taskID := c.Query("taskId")
		if taskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Task ID is required"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to view comments of this task"})
			return
		}

		rows, err := db.Query(`
			SELECT id, content, author, task_id, user_id, created_at, updated_at
			FROM comments
			WHERE task_id = ?
			ORDER BY created_at ASC
		`, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get comments"})
			return
		}
		defer rows.Close()

		var comments []gin.H
		for rows.Next() {
			var id, content, author, taskID, userID string
			var createdAt, updatedAt string
			if err := rows.Scan(&id, &content, &author, &taskID, &userID, &createdAt, &updatedAt); err == nil {
				comment := gin.H{
					"id":        id,
					"content":   content,
					"author":    author,
					"taskId":    taskID,
					"createdAt": createdAt,
					"updatedAt": updatedAt,
				}
				if userID != "" {
					comment["userId"] = userID
				}
				comments = append(comments, comment)
			}
		}

		c.JSON(http.StatusOK, comments)
	}
}

// GetComment returns a single comment by ID
func GetComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		commentID := c.Param("id")
		if commentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Comment ID is required"})
			return
		}

		var id, content, author, taskID, userID string
		var createdAt, updatedAt string
		err := db.QueryRow(`
			SELECT id, content, author, task_id, user_id, created_at, updated_at
			FROM comments
			WHERE id = ?
		`, commentID).Scan(&id, &content, &author, &taskID, &userID, &createdAt, &updatedAt)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Comment not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get comments"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to view this comment"})
			return
		}

		comment := gin.H{
			"id":        id,
			"content":   content,
			"author":    author,
			"taskId":    taskID,
			"createdAt": createdAt,
			"updatedAt": updatedAt,
		}
		if userID != "" {
			comment["userId"] = userID
		}

		c.JSON(http.StatusOK, comment)
	}
}

// CreateCommentRequest represents comment creation request
type CreateCommentRequest struct {
	Content string `json:"content" validate:"required,max=2000"`
	TaskID  string `json:"taskId" validate:"required"`
}

// CreateComment creates a new comment
func CreateComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot add comments"})
			return
		}

		if !checkRateLimit("comment:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		var req CreateCommentRequest
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
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to add comment to this task"})
			return
		}

		commentID := generateID()
		now := time.Now()
		author := user.Nickname

		_, err = db.Exec(
			"INSERT INTO comments (id, content, author, task_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			commentID, req.Content, author, req.TaskID, user.ID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create comment"})
			return
		}

		if user.Type == "AGENT" {
			LogActivity(db, user.ID, "ADD_COMMENT", "COMMENT", commentID, req.Content[:min(50, len(req.Content))]+"...", "", c.ClientIP(), getRequestSource(c))
		}

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":        commentID,
			"content":   req.Content,
			"author":    author,
			"userId":    user.ID,
			"taskId":    req.TaskID,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}
