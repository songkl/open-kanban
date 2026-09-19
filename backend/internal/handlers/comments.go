package handlers

import (
	"database/sql"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"open-kanban/internal/models"
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

		go dispatchCommentMentions(db, user, commentID, req.TaskID, req.Content)

		broadcast()

		publishTaskCommented(db, req.TaskID, commentID, req.Content, author, user.ID, sql.NullTime{Time: now, Valid: true})

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

// dispatchCommentMentions fans out TASK_MENTIONED notifications for
// every @nickname in the comment body. It is intentionally fire-
// and-forget (the caller does `go dispatchCommentMentions(...)`)
// because the originating POST has already returned by the time we
// get here and the user-visible latency must not include the WS
// broadcast round-trip.
//
// Self-mentions are skipped: pinging yourself in your own comment
// would just generate noise in the bell list. Unknown nicknames are
// also skipped — the regex / lookup pair naturally tolerates typos
// because ExtractMentions returns them and ResolveUserIDsByNickname
// filters them out, so a malformed @-token never causes an error.
func dispatchCommentMentions(db *sql.DB, author *models.User, commentID, taskID, content string) {
	nicks := ExtractMentions(content)
	if len(nicks) == 0 {
		return
	}
	ids, err := ResolveUserIDsByNickname(db, nicks)
	if err != nil {
		slog.Error("dispatchCommentMentions: nickname lookup failed", "error", err)
		return
	}
	var taskTitle string
	if err := db.QueryRow("SELECT title FROM tasks WHERE id = ?", taskID).Scan(&taskTitle); err != nil {
		slog.Error("dispatchCommentMentions: task lookup failed", "error", err, "taskID", taskID)
		return
	}
	title := author.Nickname + " mentioned you"
	body := "In: " + taskTitle
	for id, nick := range ids {
		if id == author.ID {
			continue
		}
		if err := InsertNotification(db, id, NotificationSourceTaskMentioned, title, body, "COMMENT", commentID); err != nil {
			slog.Error("dispatchCommentMentions: insert failed", "error", err, "userID", id, "nick", nick)
		}
	}
}
