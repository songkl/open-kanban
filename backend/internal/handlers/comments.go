package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

// GetComments returns comments for a task
func GetComments(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)

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

		if user != nil && !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
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

		if user != nil && !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
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

// CreateCommentRequest represents comment creation request.
//
// The Content field intentionally has no `max=` validator tag:
// comment length is unbounded on purpose so the API never rejects
// long-form feedback just because it crosses a character threshold.
// The storage column is LONGTEXT on MySQL (max 4 GiB, migration
// 007_extend_comment_content) and TEXT on SQLite (variable-length up
// to ~1 GiB), so the handler is free of length checks at every
// layer. See CreateComment for the full list of 400 conditions.
type CreateCommentRequest struct {
	Content string `json:"content" validate:"required"`
	TaskID  string `json:"taskId" validate:"required"`
}

// CreateComment creates a new comment.
//
// POST /api/v1/comments
//
// Status code semantics:
//
//   - 200 OK: comment inserted, response carries the new id/content/author/userId/taskId/timestamps.
//   - 400 Bad Request — every documented client error:
//   -   • "content is required"      — `content` missing or empty (validator `required`).
//   -   • "taskId is required"       — `taskId` missing or empty   (validator `required`).
//   -   • "Invalid task ID"          — `taskId` does not reference any existing task.
//     Note: length of `content` is NOT a 400 condition. Anything that would
//     historically have surfaced as a "too long" 400 is intentionally
//     allowed all the way through to storage (LONGTEXT / SQLite TEXT).
//   - 401 Unauthorized: caller is not logged in.
//   - 403 Forbidden: caller is a VIEWER, or lacks WRITE access on the task's board.
//   - 429 Too Many Requests: per-user rate limit on `comment:<userID>` tripped.
//   - 500 Internal Server Error: DB INSERT failed (very rare, only on driver-level errors).
func CreateComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
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

		go func() {
			webhookSvc := services.GetWebhookService()
			var taskID, title, columnID, priority string
			var assignee *string
			db.QueryRow("SELECT id, title, column_id, priority, assignee FROM tasks WHERE id = ?", req.TaskID).Scan(&taskID, &title, &columnID, &priority, &assignee)
			columnName := getColumnName(db, columnID)
			webhookSvc.NotifyTaskCommented(services.WebhookTask{
				ID:         taskID,
				Title:      title,
				ColumnID:   columnID,
				ColumnName: columnName,
				Priority:   priority,
				Assignee:   derefString(assignee),
			})
		}()

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
