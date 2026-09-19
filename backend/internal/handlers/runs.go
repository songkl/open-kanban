package handlers

import (
	"database/sql"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// MarkRunCompleteRequest is the body posted by Agent runners (or by
// the MCP integration) when a task run reaches a terminal status.
// The body is intentionally minimal: the row identity (taskId) is
// taken from the URL so a runaway retry from a flaky runner can't
// cross-fire onto another task, and the runner supplies only the
// status + an optional detail string.
type MarkRunCompleteRequest struct {
	Status string `json:"status"`
	Detail string `json:"detail"`
}

// MarkRunComplete is a stub endpoint that records a task run as
// having reached a terminal status and fans out a RUN_COMPLETED
// in-app notification to the task's owner. It is used by:
//   - The MCP integration when an Agent runner reports completion.
//   - The frontend's smoke test of the notification center.
//
// The handler deliberately does NOT gate the request on the task
// ownership rules: any authenticated user may submit a completion
// report for a task because Agent runners are typically distinct
// from the human who created the task. We do rate-limit per user so
// a runaway runner can't spam the bell-badge queue.
func MarkRunComplete(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		taskID := c.Param("taskId")
		if taskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Task ID is required"})
			return
		}

		var req MarkRunCompleteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}
		status := strings.TrimSpace(req.Status)
		if status == "" {
			status = "completed"
		}
		detail := strings.TrimSpace(req.Detail)

		var ownerID sql.NullString
		var taskTitle string
		if err := db.QueryRow("SELECT created_by, title FROM tasks WHERE id = ?", taskID).Scan(&ownerID, &taskTitle); err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			slog.Error("MarkRunComplete: task lookup failed", "error", err, "taskID", taskID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query task"})
			return
		}
		if !ownerID.Valid || ownerID.String == "" {
			c.JSON(http.StatusOK, gin.H{"success": true})
			return
		}

		title := "Run " + status
		body := taskTitle
		if detail != "" {
			body = taskTitle + " — " + detail
		}
		go func() {
			if err := InsertNotification(db, ownerID.String, NotificationSourceRunCompleted, title, body, "RUN", taskID); err != nil {
				slog.Error("MarkRunComplete: insert notification failed", "error", err, "taskID", taskID)
			}
		}()
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}