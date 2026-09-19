package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

// BulkColumnActionRequest is the body for POST /api/v1/tasks/bulk/column-action.
// It powers the column-header ⋯ menu introduced in s-1212 so a single
// click can archive every task in a column or advance every task to
// the next workflow column (PM_REVIEW_2026-09-17 §3.2 finding #4).
//
// `action` accepts "archive" or "complete" today. Adding a new
// column-level action means extending the allow-list below and
// mirroring the action name in the activities CHECK list
// (migration 015_add_column_bulk_actions.*).
type BulkColumnActionRequest struct {
	ColumnID string `json:"columnId" validate:"required"`
	Action   string `json:"action"   validate:"required,oneof=archive complete"`
	// AffectedIDs is optional and only used for the response preview
	// shape. When the client passes the IDs it already has rendered,
	// the handler echoes them back so the confirmation dialog can
	// list exactly the tasks the user just clicked "Confirm" on. The
	// server does NOT trust this list — it always re-queries the
	// column so a stale client cannot trick the handler into
	// skipping rows.
	AffectedIDs []string `json:"affectedIds,omitempty"`
}

// BulkColumnActionResponse is the JSON the new handler returns.
// `affected` is the list of task IDs that were touched so the
// client can flash a "N tasks archived" toast and the WebSocket
// fan-out can keep the board in sync.
type BulkColumnActionResponse struct {
	Action   string   `json:"action"`
	ColumnID string   `json:"columnId"`
	Affected []string `json:"affected"`
	Count    int      `json:"count"`
	Skipped  int      `json:"skipped"`
}

// BulkColumnAction handles POST /api/v1/tasks/bulk/column-action.
// It is the single-column counterpart to BatchUpdateTasks: instead
// of accepting an explicit list of task IDs from the client, the
// handler resolves every live (non-archived, non-draft) task in
// the named column and applies the action in one shot.
//
// The audit log entry targets the COLUMN itself (target_type =
// "COLUMN", target_id = columnID) so the activity log can answer
// "who just emptied this column?" without paging through per-task
// rows. A single row per request, not per task — the per-task
// accounting lives on each task's updated_at + the individual
// UPDATE_TASK / COMPLETE_TASK row that the service layer already
// emits.
func BulkColumnAction(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if requireNonViewer(c, user) {
			return
		}

		var req BulkColumnActionRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if req.ColumnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "columnId is required"})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, req.ColumnID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to operate on this column"})
			return
		}

		columnName := getColumnName(db, req.ColumnID)
		if columnName == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Column not found"})
			return
		}

		// Load every live task in the column once, so the rest of
		// the handler can stay single-pass and so the audit-log
		// `details` field can carry the exact count without a
		// second round-trip. "Live" means published + not
		// archived — drafts and already-archived rows are
		// excluded because archiving them again would be a no-op
		// the user did not intend, and advancing them through
		// the workflow would silently move private work onto the
		// board.
		rows, err := db.Query(
			`SELECT id, title FROM tasks WHERE column_id = ? AND archived = 0 AND published = 1 ORDER BY position ASC`,
			req.ColumnID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load column tasks"})
			return
		}
		type taskRef struct {
			id    string
			title string
		}
		var targets []taskRef
		for rows.Next() {
			var ref taskRef
			if err := rows.Scan(&ref.id, &ref.title); err == nil {
				targets = append(targets, ref)
			}
		}
		rows.Close()

		if len(targets) == 0 {
			c.JSON(http.StatusOK, BulkColumnActionResponse{
				Action:   req.Action,
				ColumnID: req.ColumnID,
				Affected: []string{},
				Count:    0,
				Skipped:  0,
			})
			return
		}

		taskService := services.NewTaskService(db)

		var affected []string
		var skipped []string

		switch req.Action {
		case "archive":
			// canModifyTask only applies to MEMBER users; ADMINs
			// and the board owner can archive rows they did not
			// create. ArchiveTask on the service is a single
			// UPDATE so it is safe to loop even on large columns.
			for _, target := range targets {
				if user.Role == "MEMBER" {
					allowed, err := canModifyTask(db, user, target.id)
					if err != nil || !allowed {
						skipped = append(skipped, target.id)
						continue
					}
				}
				if _, err := taskService.ArchiveTask(target.id, true); err != nil {
					skipped = append(skipped, target.id)
					continue
				}
				affected = append(affected, target.id)
			}

		case "complete":
			// "Complete" means "advance to the next workflow
			// column". For tasks already in the last column the
			// service returns an error, which we record as
			// skipped rather than failing the whole batch — the
			// user asked for a bulk action and the partial
			// outcome is more useful than a 400.
			//
			// canModifyTask does not apply when moving to the
			// next column because the destination column's
			// WRITE access already covers the move; the
			// individual CompleteTask path through the regular
			// handler checks this same column access.
			for _, target := range targets {
				if user.Role == "MEMBER" {
					allowed, err := canModifyTask(db, user, target.id)
					if err != nil || !allowed {
						skipped = append(skipped, target.id)
						continue
					}
				}
				if _, err := taskService.CompleteTask(target.id); err != nil {
					skipped = append(skipped, target.id)
					continue
				}
				affected = append(affected, target.id)
			}

		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported action"})
			return
		}

		// One audit row per column-level action so the activity
		// log stays scannable. The details string carries the
		// counts so a reader doesn't have to re-derive them from
		// the per-task UPDATE_TASK / COMPLETE_TASK rows that the
		// service layer already emitted.
		details := fmt.Sprintf("column=%q action=%s affected=%d skipped=%d", columnName, req.Action, len(affected), len(skipped))
		activityAction := bulkColumnActivityAction(req.Action)
		if activityAction != "" {
			LogActivity(db, user.ID, activityAction, "COLUMN", req.ColumnID, columnName, details, c.ClientIP(), getRequestSource(c))
		}

		broadcast()

		if len(affected) == 0 {
			// Surface the failure to the client but keep the
			// 200 envelope — the partial-success shape matches
			// BatchUpdateTasks so the frontend can render a
			// consistent "0 archived" toast either way.
			c.JSON(http.StatusOK, BulkColumnActionResponse{
				Action:   req.Action,
				ColumnID: req.ColumnID,
				Affected: []string{},
				Count:    0,
				Skipped:  len(skipped),
			})
			return
		}

		c.JSON(http.StatusOK, BulkColumnActionResponse{
			Action:   req.Action,
			ColumnID: req.ColumnID,
			Affected: affected,
			Count:    len(affected),
			Skipped:  len(skipped),
		})
	}
}

// bulkColumnActivityAction maps the public action verbs to the
// internal activity-log action names. Kept as a helper so the
// allow-list in the request validator and the migration's CHECK
// list stay easy to audit together — if a new verb lands here it
// also needs a migration that widens activities.action.
func bulkColumnActivityAction(action string) string {
	switch strings.ToLower(action) {
	case "archive":
		return "BULK_ARCHIVE_COLUMN"
	case "complete":
		return "BULK_COMPLETE_COLUMN"
	default:
		return ""
	}
}
