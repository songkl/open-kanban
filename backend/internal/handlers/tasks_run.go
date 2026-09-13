package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
	"open-kanban/internal/services"
)

// DefaultRunLockTimeoutMs is the fallback lock timeout used by
// the claim / heartbeat handlers when the request body does
// not specify one. The CLI runner typically sends its own
// lockTimeoutMs (matching runner.lockTimeoutMs in
// .kanban-runner.yaml); this default is only the safety net.
const DefaultRunLockTimeoutMs = 120000

// ClaimRunRequest is the wire shape for POST /api/v1/runs/claim.
// See devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml `ClaimRunRequest`
// for the full contract.
type ClaimRunRequest struct {
	BoardID        string `json:"boardId"`
	Status         string `json:"status"`
	AgentType      string `json:"agentType"`
	RunnerID       string `json:"runnerId"`
	Mode           string `json:"mode,omitempty"`
	LockTimeoutMs  int    `json:"lockTimeoutMs,omitempty"`
}

// HeartbeatRunRequest is the wire shape for POST
// /api/v1/runs/:taskId/heartbeat.
type HeartbeatRunRequest struct {
	RunnerID      string `json:"runnerId"`
	LockTimeoutMs int    `json:"lockTimeoutMs,omitempty"`
}

// FinishRunRequest is the wire shape for POST
// /api/v1/runs/:taskId/finish.
type FinishRunRequest struct {
	RunnerID      string  `json:"runnerId"`
	Status        string  `json:"status"`
	ExitCode      *int    `json:"exitCode,omitempty"`
	Error         *string `json:"error,omitempty"`
}

// ReleaseRunsRequest is the wire shape for POST
// /api/v1/runs/release.
type ReleaseRunsRequest struct {
	RunnerID string   `json:"runnerId"`
	TaskIDs  []string `json:"taskIds,omitempty"`
}

// ClaimRun handles POST /api/v1/runs/claim. See §3.4 of
// devDoc/CLI_RUNNER_PLAN_2026-09-12.md for the canonical
// contract; OpenAPI reference is
// devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml `claimRun`.
//
// Authorization:
//   - RequireAuth(db) (mounted at the route level)
//   - WRITE access on at least one column that matches
//     (boardId, status). For mode=mine the check falls back to
//     the user's existing /mcp/my-tasks permission model and we
//     skip the per-column WRITE check.
func ClaimRun(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if requireNonViewer(c, user) {
			return
		}

		var req ClaimRunRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}
		if req.BoardID == "" || req.Status == "" || req.AgentType == "" || req.RunnerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "boardId, status, agentType and runnerId are required"})
			return
		}

		mode := req.Mode
		if mode == "" {
			mode = "board"
		}
		if mode != "board" && mode != "mine" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "mode must be 'board' or 'mine'"})
			return
		}

		// Authorization: at least one column on the board
		// matching the requested status must grant WRITE. This
		// mirrors what CreateTask already enforces (per-column
		// or board fallback); a runner is essentially "the CLI
		// version of a task creator". For mode=mine the check
		// is deferred to the per-task access verification
		// below — the user can have access to tasks on any
		// board they have a grant on, not a specific one.
		if mode == "board" {
			if !userHasBoardStatusWrite(db, user, req.BoardID, req.Status) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to claim tasks in this column"})
				return
			}
		} else {
			// mode=mine: the user must have at least one
			// claimable task across the system, but the
			// per-task permission is enforced by the existing
			// GetMyTasks filter plus a board access check on
			// the resolved task below.
			if !userHasAnyClaimableTask(db, user, req.AgentType) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No claimable tasks for this user"})
				return
			}
		}

		lockTimeoutMs := req.LockTimeoutMs
		if lockTimeoutMs <= 0 {
			lockTimeoutMs = DefaultRunLockTimeoutMs
		}

		// Snapshot the calling token's user_agent — that is
		// the agent type the runner is willing to pick up.
		// We validate it matches what the body claimed so a
		// stolen token can't claim for an unrelated agent.
		tokenUserAgent := readTokenUserAgent(db, c)
		if tokenUserAgent != "" && tokenUserAgent != req.AgentType {
			c.JSON(http.StatusForbidden, gin.H{"error": "token user_agent does not match agentType"})
			return
		}

		repo := repositories.NewRunRepository(db)

		var (
			taskID, columnID string
			err              error
		)
		if mode == "mine" {
			taskID, columnID, err = pickMyTaskForClaim(db, user, req.AgentType)
		} else {
			taskID, columnID, err = repo.FindEligibleTask(req.BoardID, req.Status, req.AgentType)
		}
		if err != nil {
			if err == repositories.ErrNoRunRow {
				c.Status(http.StatusNoContent)
				return
			}
			ServerError(c, "Failed to find eligible task", err)
			return
		}

		// Resolve the board id from the column (the body
		// supplied one but the column is the source of truth
		// for cross-board safety).
		boardID, err := getBoardIDForColumn(db, columnID)
		if err != nil {
			ServerError(c, "Failed to resolve column board", err)
			return
		}
		if mode == "board" && boardID != req.BoardID {
			// Defence in depth — should be impossible given
			// the SQL filter, but a manual column move could
			// land a task on a column that doesn't belong to
			// the requested board.
			c.JSON(http.StatusBadRequest, gin.H{"error": "task column does not belong to requested board"})
			return
		}

		// mode=mine: confirm the user can access the task's
		// board before claiming (matters when the runner has
		// WRITE on board X but is asking for a task on
		// board Y because they own it as an assignee).
		if mode == "mine" && !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to claim tasks on the resolved board"})
			return
		}

		inProgressColumnID, err := repo.FindInProgressColumn(boardID)
		if err != nil {
			ServerError(c, "Failed to find in_progress column", err)
			return
		}

		// Persist req.RunnerID (the stable runner identity the CLI
		// generated, e.g. "host-pid-uuid") rather than user.ID so
		// the heartbeat + finish round-trips can verify ownership
		// against the same value the runner sends back. Using
		// user.ID here would mean the runner's heartbeat is
		// rejected with 409 the first time its own runnerId string
		// doesn't happen to match the user record primary key.
		claim, err := repo.ClaimRun(boardID, taskID, columnID, req.RunnerID, req.AgentType, inProgressColumnID, lockTimeoutMs)
		if err != nil {
			if err == repositories.ErrLockHeld {
				// Transient — another runner beat us to this
				// task. Recurse by trying the next eligible
				// task. We bound recursion by a small budget
				// to avoid pathological loops.
				c.Status(http.StatusNoContent)
				return
			}
			ServerError(c, "Failed to claim task", err)
			return
		}

		// Return the canonical task JSON the runner needs to
		// render the prompt — same shape as GET /api/v1/tasks/:id.
		taskJSON, err := renderTaskJSON(db, taskID)
		if err != nil {
			ServerError(c, "Failed to load claimed task", err)
			return
		}

		// Fan out a task_notification so any WebSocket
		// subscriber watching this board sees the live state
		// change without waiting for the 5-second refresh
		// poll. Action mirrors the legacy `LogActivity` —
		// `update_status` is what the front-end's
		// `useBoardWebSocket` hook already knows how to
		// diff-merge into the local cache.
		BroadcastTaskNotificationExternal(boardID, taskID, "update_status")

		c.JSON(http.StatusOK, gin.H{
			"task": taskJSON,
			"run":  claim.Run,
		})
	}
}

// HeartbeatRun handles POST /api/v1/runs/:taskId/heartbeat.
// Returns 200 with the new expires_at on success, 404 when no
// run row exists, 409 when the lock is held by another runner
// or has been reaped.
func HeartbeatRun(db *sql.DB) gin.HandlerFunc {
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

		var req HeartbeatRunRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}
		if req.RunnerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "runnerId is required"})
			return
		}

		lockTimeoutMs := req.LockTimeoutMs
		if lockTimeoutMs <= 0 {
			lockTimeoutMs = DefaultRunLockTimeoutMs
		}

		repo := repositories.NewRunRepository(db)
		expiresAt, err := repo.Heartbeat(taskID, req.RunnerID, lockTimeoutMs)
		if err != nil {
			switch err {
			case repositories.ErrNoRunRow:
				c.JSON(http.StatusNotFound, gin.H{"error": "Run not found"})
			case repositories.ErrLockHeld:
				c.JSON(http.StatusConflict, gin.H{"error": "Lock no longer held by this runner"})
			default:
				ServerError(c, "Failed to refresh heartbeat", err)
			}
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"expiresAt": expiresAt.UTC().Format(time.RFC3339),
		})
	}
}

// AttachRunRequest is the wire shape for POST
// /api/v1/runs/:taskId/attach. Mirrors HeartbeatRunRequest
// plus an optional `reason` field the operator can use to
// annotate why the runner is grabbing this task (free-form,
// surfaced through the activity stream so the audit trail
// stays meaningful).
type AttachRunRequest struct {
	RunnerID      string `json:"runnerId"`
	AgentType     string `json:"agentType,omitempty"`
	LockTimeoutMs int    `json:"lockTimeoutMs,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

// AttachRun handles POST /api/v1/runs/:taskId/attach. Unlike
// ClaimRun (which scans a column for the next eligible task),
// the attach verb lets a runner / operator claim one specific
// task by id without owning the surrounding column or inbox.
//
// This is the "AI-first" entry point — an agent that has been
// handed a taskId (via the UI, MCP, or a queue) can attach to
// it directly. The endpoint still enforces the same per-column
// WRITE permission as the rest of the runner API so a stolen
// token can't grab tasks on boards the runner has no access to.
//
// 200 — { task, run } in the same shape as ClaimRun so the CLI
//        prompt-rendering path is identical.
// 403 — caller lacks WRITE on the resolved column / board.
// 404 — task does not exist.
// 409 — task already locked by another runner with a non-expired
//        claim (handler maps repositories.ErrLockHeld → 409).
// 422 — task is archived or unpublished (the attach path only
//        operates on visible, non-archive tasks).
func AttachRun(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if requireNonViewer(c, user) {
			return
		}

		taskID := c.Param("taskId")
		if taskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Task ID is required"})
			return
		}

		var req AttachRunRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}
		if req.RunnerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "runnerId is required"})
			return
		}

		// Resolve task → column → board up front. We re-use
		// the same helpers as GetRun so the access check and
		// the claim transaction see the same column/board
		// pair.
		columnID, err := getColumnIDForTask(db, taskID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			ServerError(c, "Failed to load task", err)
			return
		}
		boardID, err := getBoardIDForColumn(db, columnID)
		if err != nil {
			ServerError(c, "Failed to resolve column board", err)
			return
		}

		// Authorization: WRITE on the resolved column (with
		// board fallback). This mirrors FinishRun so the
		// attach path can't be used as a privilege escalation
		// vector — you can only attach to tasks on boards
		// you could already move.
		if !HasColumnWrite(db, user, boardID, columnID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to attach to this task"})
			return
		}

		// Reject archived / unpublished tasks up front so the
		// caller gets a clear 422 instead of a misleading
		// lock-held response.
		var (
			archived   bool
			published  bool
			taskTitle  string
		)
		if err := db.QueryRow(
			"SELECT archived, published, title FROM tasks WHERE id = ?",
			taskID,
		).Scan(&archived, &published, &taskTitle); err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			ServerError(c, "Failed to load task state", err)
			return
		}
		if archived {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Task is archived"})
			return
		}
		if !published {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Task is not published"})
			return
		}

		// Resolve the agent type — prefer the explicit body
		// value, fall back to the calling token's user_agent
		// (same source-of-truth ClaimRun uses). When neither
		// is set we leave agent_id empty so ClaimRun stores
		// NULL — the lock row is still valid for ownership
		// checks, we just don't tag it with an agent class.
		agentType := strings.TrimSpace(req.AgentType)
		if agentType == "" {
			agentType = strings.TrimSpace(readTokenUserAgent(db, c))
		}
		if agentType != "" {
			tokenUserAgent := strings.TrimSpace(readTokenUserAgent(db, c))
			if tokenUserAgent != "" && tokenUserAgent != agentType {
				c.JSON(http.StatusForbidden, gin.H{"error": "token user_agent does not match agentType"})
				return
			}
		}

		lockTimeoutMs := req.LockTimeoutMs
		if lockTimeoutMs <= 0 {
			lockTimeoutMs = DefaultRunLockTimeoutMs
		}

		repo := repositories.NewRunRepository(db)
		inProgressColumnID, err := repo.FindInProgressColumn(boardID)
		if err != nil {
			ServerError(c, "Failed to find in_progress column", err)
			return
		}

		claim, err := repo.ClaimRun(boardID, taskID, columnID, req.RunnerID, agentType, inProgressColumnID, lockTimeoutMs)
		if err != nil {
			switch err {
			case repositories.ErrLockHeld:
				c.JSON(http.StatusConflict, gin.H{"error": "Task is already locked by another runner"})
			default:
				ServerError(c, "Failed to attach task", err)
			}
			return
		}

		// Surface the attach event through the activity stream
		// so the UI / other subscribers see the same audit trail
		// as a normal claim. The reason (if supplied) lands in
		// the details column so operators can tell apart
		// "scanner grabbed it" from "operator pinned this
		// task to a specific runner".
		details := "attached via /api/v1/runs/:taskId/attach"
		if req.Reason != "" {
			details = "attached: " + req.Reason
		}
		LogActivity(db, user.ID, "CLAIM_TASK", "TASK", taskID, taskTitle, details, c.ClientIP(), getRequestSource(c))

		// Fan out a task_notification so any WebSocket
		// subscriber watching this board sees the live state
		// change without waiting for the 5-second refresh
		// poll. The broadcastQueue is async (goroutine), so
		// the HTTP response isn't delayed by it.
		BroadcastTaskNotificationExternal(boardID, taskID, "attach")

		taskJSON, err := renderTaskJSON(db, taskID)
		if err != nil {
			ServerError(c, "Failed to load attached task", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"task": taskJSON,
			"run":  claim.Run,
		})
	}
}

// FinishRun handles POST /api/v1/runs/:taskId/finish.
// When status='completed' the handler invokes
// task_service.CompleteTask so the task advances to its next
// column; on 'failed' the task stays in its current column
// (typically in_progress) per requirement F8.
func FinishRun(db *sql.DB) gin.HandlerFunc {
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

		// Authorization: the user must have WRITE access on the
		// task's current column (with board fallback) — mirrors
		// the claim path so a runner that lost its column grant
		// between claim and finish can't advance the task.
		columnID, err := getColumnIDForTask(db, taskID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			ServerError(c, "Failed to load task", err)
			return
		}
		boardID, err := getBoardIDForColumn(db, columnID)
		if err != nil {
			ServerError(c, "Failed to load task board", err)
			return
		}
		if !HasColumnWrite(db, user, boardID, columnID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to finish tasks in this column"})
			return
		}

		var req FinishRunRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}
		if req.RunnerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "runnerId is required"})
			return
		}

		var status models.RunStatus
		switch req.Status {
		case "completed":
			status = models.RunStatusCompleted
		case "failed":
			status = models.RunStatusFailed
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "status must be 'completed' or 'failed'"})
			return
		}

		repo := repositories.NewRunRepository(db)
		taskSvc := services.NewTaskService(db)

		var advanced bool
		err = repo.FinishRun(taskID, req.RunnerID, status, req.ExitCode, req.Error,
			func(taskID string) error {
				if _, err := taskSvc.CompleteTask(taskID); err != nil {
					return err
				}
				advanced = true
				return nil
			},
		)
		if err != nil {
			switch err {
			case repositories.ErrNoRunRow:
				c.JSON(http.StatusNotFound, gin.H{"error": "Run not found"})
			case repositories.ErrLockHeld:
				c.JSON(http.StatusConflict, gin.H{"error": "Run is not owned by this runner"})
			default:
				ServerError(c, "Failed to finish run", err)
			}
			return
		}

		// Surface the terminal state to the WebSocket fanout
		// so the UI can re-render without polling.
		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"success":  true,
			"advanced": advanced,
		})
	}
}

// ReleaseRuns handles POST /api/v1/runs/release. Bulk-releases
// every task_runs row owned by runnerId; optionally scoped to
// taskIds. Idempotent — already-terminal rows are skipped.
func ReleaseRuns(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req ReleaseRunsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}
		if req.RunnerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "runnerId is required"})
			return
		}

		repo := repositories.NewRunRepository(db)
		released, err := repo.ReleaseRuns(req.RunnerID, req.TaskIDs)
		if err != nil {
			slog.Error("ReleaseRuns failed", "error", err, "runnerId", req.RunnerID, "taskIds", req.TaskIDs)
			ServerError(c, "Failed to release runs", err)
			return
		}

		if released > 0 {
			broadcast()
		}

		c.JSON(http.StatusOK, gin.H{"released": released})
	}
}

// GetRun handles GET /api/v1/runs/:taskId. Returns the current
// task_runs row so the web UI can render the "claimed by X"
// badge.
func GetRun(db *sql.DB) gin.HandlerFunc {
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

		// Lightweight column permission gate — same READ
		// access as the underlying task. Falls back to the
		// board-level grant via checkColumnAccessWithBoardFallback.
		columnID, err := getColumnIDForTask(db, taskID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
				return
			}
			ServerError(c, "Failed to load task", err)
			return
		}
		if !checkColumnAccessWithBoardFallback(db, user.ID, columnID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to view this run"})
			return
		}

		repo := repositories.NewRunRepository(db)
		run, err := repo.GetRun(taskID)
		if err != nil {
			if err == repositories.ErrNoRunRow {
				c.JSON(http.StatusNotFound, gin.H{"error": "Run not found"})
				return
			}
			ServerError(c, "Failed to load run", err)
			return
		}

		c.JSON(http.StatusOK, run)
	}
}

// ListRunsHistory handles GET /api/v1/runs/history. Returns
// every terminal task_runs row (status ∈ completed, failed,
// released) that the caller has READ access to, ordered by
// finished_at DESC. Live rows are excluded — those are surfaced
// by GetRun on the task card, not the history page.
//
// Query params (all optional):
//
//   - runnerId  filter by runner identifier (string exact match)
//   - status    filter by terminal status (completed|failed|released)
//   - boardId   filter by board (comma-separated allow-list)
//   - taskId    filter by task identifier
//   - from      ISO-8601 lower bound on finished_at
//   - to        ISO-8601 upper bound on finished_at
//   - limit     pagination size, default 50, capped at 200
//   - offset    pagination offset, default 0
//
// Authorization: same column READ access as the underlying
// tasks — implemented as a post-filter that drops rows the
// caller cannot see. ADMIN sees everything. Unknown columns
// (e.g. board deleted out from under a finished run) are dropped
// silently rather than leaking IDs.
func ListRunsHistory(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		filter := repositories.RunHistoryFilter{
			RunnerID: strings.TrimSpace(c.Query("runnerId")),
			TaskID:   strings.TrimSpace(c.Query("taskId")),
		}

		if rawStatus := strings.TrimSpace(c.Query("status")); rawStatus != "" {
			st := models.RunStatus(rawStatus)
			switch st {
			case models.RunStatusCompleted, models.RunStatusFailed, models.RunStatusReleased:
				filter.Status = st
			default:
				c.JSON(http.StatusBadRequest, gin.H{"error": "status must be 'completed', 'failed', or 'released'"})
				return
			}
		}

		if rawBoards := strings.TrimSpace(c.Query("boardId")); rawBoards != "" {
			for _, id := range strings.Split(rawBoards, ",") {
				id = strings.TrimSpace(id)
				if id != "" {
					filter.BoardIDs = append(filter.BoardIDs, id)
				}
			}
		}

		if rawFrom := strings.TrimSpace(c.Query("from")); rawFrom != "" {
			t, err := parseHistoryTime(rawFrom)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid 'from' timestamp (expected RFC3339 or YYYY-MM-DD)"})
				return
			}
			filter.From = t
		}
		if rawTo := strings.TrimSpace(c.Query("to")); rawTo != "" {
			t, err := parseHistoryTime(rawTo)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid 'to' timestamp (expected RFC3339 or YYYY-MM-DD)"})
				return
			}
			filter.To = t
		}
		if !filter.From.IsZero() && !filter.To.IsZero() && filter.To.Before(filter.From) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "'to' must be >= 'from'"})
			return
		}

		if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
			n, err := strconv.Atoi(rawLimit)
			if err != nil || n <= 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
				return
			}
			filter.Limit = n
		}
		if rawOffset := strings.TrimSpace(c.Query("offset")); rawOffset != "" {
			n, err := strconv.Atoi(rawOffset)
			if err != nil || n < 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "offset must be a non-negative integer"})
				return
			}
			filter.Offset = n
		}

		repo := repositories.NewRunRepository(db)
		rows, err := repo.ListRunHistory(filter)
		if err != nil {
			ServerError(c, "Failed to list run history", err)
			return
		}

		// Post-filter by READ permission: a row is visible if the
		// caller has READ access on the snapshot column_id (with
		// board fallback), OR READ access on the underlying task's
		// current column. The task may have moved since the run
		// finished — CompletedTask advances the column — so we
		// union the two and accept either. ADMIN users skip this
		// check entirely.
		if user.Role != "ADMIN" {
			visible := rows[:0]
			for _, r := range rows {
				if canSeeRunRow(db, user, r) {
					visible = append(visible, r)
				}
			}
			rows = visible
		}

		if rows == nil {
			rows = []*models.TaskRun{}
		}
		c.JSON(http.StatusOK, rows)
	}
}

// canSeeRunRow reports whether the user has READ access to a
// history row. A row is visible when either the snapshot
// `column_id` (what the task was at claim time) or the task's
// *current* column grants READ — covering both "I never moved
// the task since it ran" and "the runner finished and CompleteTask
// advanced the column". ADMIN short-circuits to true.
func canSeeRunRow(db *sql.DB, user *models.User, r *models.TaskRun) bool {
	if user == nil || r == nil {
		return false
	}
	if user.Role == "ADMIN" {
		return true
	}
	if r.ColumnID != "" && checkColumnAccessWithBoardFallback(db, user.ID, r.ColumnID, "READ", user.Role) {
		return true
	}
	// Fallback: the task's current column. Use the same lookup
	// pattern as GetRun so we resolve column_id → board_id →
	// access through the existing helpers.
	currentColumnID, err := getColumnIDForTask(db, r.TaskID)
	if err == nil && currentColumnID != "" &&
		checkColumnAccessWithBoardFallback(db, user.ID, currentColumnID, "READ", user.Role) {
		return true
	}
	return false
}

// parseHistoryTime accepts RFC3339 (preferred) and YYYY-MM-DD
// (date-only) so the CLI's `--since 1d` style flags can pass a
// bare date without forcing callers to remember the time zone
// layout. Returns the parsed time in UTC.
func parseHistoryTime(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("unrecognised timestamp %q", raw)
}

// userHasBoardStatusWrite reports whether the user has WRITE
// access on at least one column on boardID whose status equals
// status. Admins short-circuit to true via HasColumnWrite, so
// this works for global ADMIN without a per-row grant.
//
// Iterates the columns matching the status and delegates the
// actual access check to HasColumnWrite so the rule lives in
// exactly one place.
func userHasBoardStatusWrite(db *sql.DB, user *models.User, boardID, status string) bool {
	if user == nil {
		return false
	}
	if user.Role == "ADMIN" {
		return true
	}
	rows, err := db.Query(
		"SELECT id FROM columns WHERE board_id = ? AND status = ?",
		boardID, status,
	)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var colID string
		if err := rows.Scan(&colID); err != nil {
			continue
		}
		if HasColumnWrite(db, user, boardID, colID) {
			return true
		}
	}
	return false
}

// userHasAnyClaimableTask reports whether the user can claim
// at least one task somewhere on the system, so the
// /runs/claim?mode=mine endpoint can fail fast with a 403
// instead of round-tripping a task lookup that would have
// returned 204 anyway. The check is cheap and matches the
// same eligibility filter as pickMyTaskForClaim — keeping
// them in lockstep is what avoids surprising "204 when the
// user is forbidden" outcomes.
func userHasAnyClaimableTask(db *sql.DB, user *models.User, agentType string) bool {
	if user == nil {
		return false
	}
	if user.Role == "ADMIN" {
		return true
	}
	// Reuse the same per-task eligibility as pickMyTaskForClaim
	// but render it as a permission check: at least one row
	// should match. The four LIKE patterns cover the four
	// positions agentType can occupy in the column_agents
	// agent_types JSON array: exactly `["x"]`, first element,
	// middle element, last element.
	exact := `["` + agentType + `"]`
	first := `["` + agentType + `,`
	last := `,"` + agentType + `"]`
	middle := `,"` + agentType + `,`

	row := db.QueryRow(`
		SELECT EXISTS (
			SELECT 1 FROM tasks t
			JOIN columns c ON t.column_id = c.id
			LEFT JOIN column_agents ca ON c.id = ca.column_id
			WHERE t.archived = 0 AND t.published = 1
			  AND (
			      t.assignee = ?
			      OR ca.agent_types IN (?, ?, ?, ?)
			  )
			  AND NOT EXISTS (
			      SELECT 1 FROM task_runs tr
			      WHERE tr.task_id = t.id
			        AND tr.status IN ('claimed', 'running')
			        AND datetime(tr.expires_at) > datetime('now')
			  )
		)
	`, user.Nickname, exact, first, last, middle)
	var exists bool
	if err := row.Scan(&exists); err != nil {
		return false
	}
	return exists
}

// pickMyTaskForClaim is the mode='mine' counterpart of
// FindEligibleTask: it reuses the existing GetMyTasks logic to
// surface the first task the user could already see in the
// "my tasks" feed, then resolves its column.
func pickMyTaskForClaim(db *sql.DB, user *models.User, agentType string) (string, string, error) {
	// Pull the user's tokens.user_agent so the same filter that
	// powers GET /api/v1/mcp/my-tasks applies here too.
	tokenUserAgent := agentType

	columnIDs := map[string]bool{}
	rows, err := db.Query(`
		SELECT c.id, COALESCE(ca.agent_types, '[]') as agent_types
		FROM columns c
		LEFT JOIN column_agents ca ON c.id = ca.column_id
	`)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var colID, agentTypesStr string
		if err := rows.Scan(&colID, &agentTypesStr); err != nil {
			continue
		}
		if tokenUserAgent != "" && agentTypesStr != "" && agentTypesStr != "[]" {
			var types []string
			if err := json.Unmarshal([]byte(agentTypesStr), &types); err != nil {
				continue
			}
			for _, t := range types {
				if t == tokenUserAgent {
					columnIDs[colID] = true
					break
				}
			}
		}
	}

	args := []interface{}{user.Nickname}
	whereClauses := []string{"t.archived = 0", "t.published = 1"}
	if len(columnIDs) > 0 {
		colList := make([]string, 0, len(columnIDs))
		for id := range columnIDs {
			colList = append(colList, "?")
			args = append(args, id)
		}
		whereClauses = append(whereClauses,
			"(t.assignee = ? OR t.column_id IN ("+strings.Join(colList, ",")+"))")
	} else {
		whereClauses = append(whereClauses, "t.assignee = ?")
	}

	// Also skip tasks that are currently locked by a non-expired
	// task_runs row.
	whereClauses = append(whereClauses, `NOT EXISTS (
		SELECT 1 FROM task_runs tr
		WHERE tr.task_id = t.id
		  AND tr.status IN ('claimed', 'running')
		  AND datetime(tr.expires_at) > datetime('now')
	)`)

	query := `
		SELECT t.id, t.column_id
		FROM tasks t
		JOIN columns c ON t.column_id = c.id
		WHERE ` + strings.Join(whereClauses, " AND ") + `
		ORDER BY c.position ASC, t.position ASC
		LIMIT 1
	`
	var taskID, columnID string
	if err := db.QueryRow(query, args...).Scan(&taskID, &columnID); err != nil {
		if err == sql.ErrNoRows {
			return "", "", repositories.ErrNoRunRow
		}
		return "", "", err
	}
	return taskID, columnID, nil
}

// renderTaskJSON emits the canonical Task payload — same shape
// as GET /api/v1/tasks/:id — so the runner can render the
// agent prompt without a follow-up round trip. Duplicated
// rather than refactored through the task service to keep the
// claim path self-contained and the response shape stable
// against future changes to the read endpoint.
func renderTaskJSON(db *sql.DB, taskID string) (gin.H, error) {
	row := db.QueryRow(`
		SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta,
		       t.column_id, t.position, t.published, t.archived, t.archived_at,
		       t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
		       COALESCE(c.name, '') as column_name,
		       (SELECT COUNT(*) FROM comments WHERE task_id = t.id) as comment_count,
		       (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) as subtask_count
		FROM tasks t
		JOIN columns c ON t.column_id = c.id
		WHERE t.id = ?
	`, taskID)

	var (
		id, title, columnID, priority, createdBy, columnName string
		description, assignee, meta, agentID, agentPrompt    sql.NullString
		position                                              int
		published, archived                                   bool
		archivedAt                                            sql.NullTime
		createdAt, updatedAt                                  time.Time
		commentCount, subtaskCount                            int
	)
	if err := row.Scan(&id, &title, &description, &priority, &assignee, &meta,
		&columnID, &position, &published, &archived, &archivedAt,
		&agentID, &agentPrompt, &createdBy, &createdAt, &updatedAt,
		&columnName, &commentCount, &subtaskCount); err != nil {
		return nil, err
	}

	payload := gin.H{
		"id":          id,
		"title":       title,
		"priority":    priority,
		"columnId":    columnID,
		"columnName":  columnName,
		"position":    position,
		"published":   published,
		"archived":    archived,
		"createdBy":   createdBy,
		"createdAt":   createdAt,
		"updatedAt":   updatedAt,
		"_count": gin.H{
			"comments": commentCount,
			"subtasks": subtaskCount,
		},
	}
	if description.Valid {
		payload["description"] = description.String
	} else {
		payload["description"] = nil
	}
	if assignee.Valid {
		payload["assignee"] = assignee.String
	} else {
		payload["assignee"] = nil
	}
	if meta.Valid {
		payload["meta"] = meta.String
	} else {
		payload["meta"] = nil
	}
	if archivedAt.Valid {
		payload["archivedAt"] = archivedAt.Time
	} else {
		payload["archivedAt"] = nil
	}
	if agentID.Valid {
		payload["agentId"] = agentID.String
	} else {
		payload["agentId"] = nil
	}
	if agentPrompt.Valid {
		payload["agentPrompt"] = agentPrompt.String
	} else {
		payload["agentPrompt"] = nil
	}
	return payload, nil
}

// readTokenUserAgent resolves the current user's token
// user_agent — same field the /mcp/my-tasks endpoint reads —
// so the runner's claimed agent_type matches the bearer
// token's recorded agent.
func readTokenUserAgent(db *sql.DB, c *gin.Context) string {
	tokenKey := ""
	if authHeader := c.GetHeader("Authorization"); authHeader != "" {
		if strings.HasPrefix(authHeader, "Bearer ") {
			tokenKey = strings.TrimPrefix(authHeader, "Bearer ")
		}
	}
	if tokenKey == "" {
		if cookie, err := c.Cookie("kanban-token"); err == nil {
			tokenKey = cookie
		}
	}
	if tokenKey == "" {
		return ""
	}
	var userAgent string
	if err := db.QueryRow("SELECT user_agent FROM tokens WHERE `key` = ?", tokenKey).Scan(&userAgent); err != nil {
		return ""
	}
	return userAgent
}

// asInt converts the query-style ?lockTimeoutMs=NNN override
// for ad-hoc curls / debugging; the canonical path is the
// request body.
func asInt(s string) int {
	if s == "" {
		return 0
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return v
}

var _ = asInt
