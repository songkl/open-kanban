package handlers

import (
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func CreateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
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
			DueAt:       req.DueAt,
			AgentID:     req.AgentID,
			AgentPrompt: req.AgentPrompt,
			CreatedBy:   user.ID,
		})

		if err != nil {
			ServerError(c, "Failed to create task", err)
			return
		}

		// T-1207 / s-1207: re-link the attachments the modal
		// pre-uploaded (via POST /api/v1/upload before submit)
		// to the freshly minted task. The attachments table has
		// a nullable FK on tasks(id) so rows land there with
		// task_id = NULL while the task doesn't exist yet. The
		// update is constrained to "uploader_id = me AND
		// task_id IS NULL AND id IN (...)" so a malicious
		// client can't grab another user's attachment, and the
		// uploader check matches the modal flow because every
		// upload is attributed to the cookie's token user.
		if len(req.AttachmentIDs) > 0 {
			if _, err := attachUploadedFilesToTask(db, user.ID, task.ID, req.AttachmentIDs); err != nil {
				slog.Error("CreateTask: failed to attach uploaded files", "error", err, "task_id", task.ID)
			}
		}

		LogActivity(db, user.ID, "CREATE_TASK", "TASK", task.ID, task.Title, "", c.ClientIP(), getRequestSource(c))

		broadcast()

		publishTaskCreated(db, task, user.ID)

		if task.Published && task.AgentID != nil && *task.AgentID != "" {
			agentPrompt := ""
			if task.AgentPrompt != nil {
				agentPrompt = *task.AgentPrompt
			}
			taskService.TriggerAgentForTask(task.ID, *task.AgentID, agentPrompt, task.Title)
		}

		if task.Assignee != nil && *task.Assignee != "" && *task.Assignee != user.ID {
			go notifyTaskAssigned(db, *task.Assignee, user.Nickname, task.ID, task.Title)
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
			"dueAt":       task.DueAt,
			"agentId":     task.AgentID,
			"agentPrompt": task.AgentPrompt,
			"createdBy":   user.ID,
			"createdAt":   task.CreatedAt,
			"updatedAt":   task.UpdatedAt,
			"comments":    []gin.H{},
		})
	}
}

// attachUploadedFilesToTask re-links pre-uploaded attachment rows
// (created by POST /api/v1/upload before the task existed) to the
// freshly created task. The update is scoped to the uploader so a
// caller cannot attach another user's orphan row, and to task_id
// IS NULL so an already-attached attachment is not silently
// re-parented. Returns the number of rows updated so the handler
// can log a useful warning when zero rows matched (e.g. the upload
// was rejected at MIME-check time but the client still forwarded
// the id).
//
// T-1207 / s-1207, PM_REVIEW_2026-09-17 §3.12.
func attachUploadedFilesToTask(db *sql.DB, userID, taskID string, attachmentIDs []string) (int64, error) {
	if len(attachmentIDs) == 0 {
		return 0, nil
	}
	// Args must follow the placeholder order in the SQL
	// statement: task_id, uploader_id, attachment ids.
	placeholders := strings.TrimRight(strings.Repeat("?,", len(attachmentIDs)), ",")
	args := make([]interface{}, 0, len(attachmentIDs)+2)
	args = append(args, taskID, userID)
	for _, id := range attachmentIDs {
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`UPDATE attachments SET task_id = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE task_id IS NULL AND uploader_id = ? AND id IN (%s)`,
		placeholders,
	)
	res, err := db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	rows, _ := res.RowsAffected()
	return rows, nil
}

func UpdateTask(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
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

		allowed, err := canModifyTask(db, user, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
			return
		}
		if !allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": "Can only modify tasks you created"})
			return
		}

		preTask := taskSnapshotForUpdate(db, id)

		var req UpdateTaskRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		var previousAssignee *string
		if req.Assignee != nil {
			var oldAssignee sql.NullString
			if err := db.QueryRow("SELECT assignee FROM tasks WHERE id = ?", id).Scan(&oldAssignee); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load task"})
				return
			}
			if oldAssignee.Valid {
				v := oldAssignee.String
				previousAssignee = &v
			}
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
			DueAt:       req.DueAt,
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

		if req.Assignee != nil {
			newAssignee := ""
			if task.Assignee != nil {
				newAssignee = *task.Assignee
			}
			oldAssignee := ""
			if previousAssignee != nil {
				oldAssignee = *previousAssignee
			}
			if newAssignee != oldAssignee && newAssignee != "" {
				go notifyTaskAssigned(db, newAssignee, user.Nickname, id, task.Title)
			}
		}

		broadcast()

		publishTaskUpdates(db, task, columnID, req, previousAssignee, preTask)

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

		if requireNonViewer(c, user) {
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

		allowed, err := CheckTaskModifyAccess(db, user, id, columnID, "ADMIN")
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to query task: %v", err)})
			return
		}
		if !allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": "Can only delete tasks you created"})
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
		publishTaskDeleted(db, id, columnID, taskTitle)
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// notifyTaskAssigned inserts a TASK_ASSIGNED notification for the
// user picked up by the assignee update. It is intentionally a fire-
// and-forget helper (called via `go notifyTaskAssigned(...)`) so the
// originating PUT does not block on the bell-badge fan-out.
//
// The `assignee` argument is treated as a user_id — the kanban API
// stores the assignee column as the user.id (see CreateTaskRequest),
// so the value can be looked up directly. If the user has been
// disabled or removed the lookup returns sql.ErrNoRows and the
// notification is silently skipped; the task update still succeeds
// because the assignee column has no FK on it.
func notifyTaskAssigned(db *sql.DB, assignee, actorNickname, taskID, taskTitle string) {
	var enabled bool
	if err := db.QueryRow("SELECT enabled FROM users WHERE id = ?", assignee).Scan(&enabled); err != nil {
		slog.Error("notifyTaskAssigned: assignee lookup failed", "error", err, "assignee", assignee)
		return
	}
	if !enabled {
		return
	}
	title := actorNickname + " assigned you a task"
	body := taskTitle
	if err := InsertNotification(db, assignee, NotificationSourceTaskAssigned, title, body, "TASK", taskID); err != nil {
		slog.Error("notifyTaskAssigned: insert failed", "error", err, "assignee", assignee)
	}
}
