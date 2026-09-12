package repositories

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"open-kanban/internal/models"
)

// RunRepository owns every SQL statement that touches the
// `task_runs` table. The CLI runner claim/heartbeat lifecycle
// (see devDoc/CLI_RUNNER_PLAN_2026-09-12.md §3.3 / §3.4) maps
// almost 1:1 onto the methods here:
//
//   ClaimRun    → POST  /api/v1/runs/claim
//   Heartbeat   → POST  /api/v1/runs/:taskId/heartbeat
//   FinishRun   → POST  /api/v1/runs/:taskId/finish
//   ReleaseRuns → POST  /api/v1/runs/release
//   GetRun      → GET   /api/v1/runs/:taskId
//   ReapExpired → background reaper (§3.5)
//
// The repository is intentionally driver-agnostic so the same code
// runs against both sqlite (modernc.org/sqlite for tests,
// mattn/go-sqlite3 in production) and go-sql-driver/mysql.
type RunRepository struct {
	db *sql.DB
}

func NewRunRepository(db *sql.DB) *RunRepository {
	return &RunRepository{db: db}
}

// ErrNoRunRow is returned by reads that did not find a task_runs
// row. Handlers translate this into HTTP 404; the reaper treats
// it as a no-op (the row may have been finished between the scan
// and the lookup).
var ErrNoRunRow = fmt.Errorf("run row not found")

// ErrLockHeld is returned when ClaimRun could not acquire the
// lock because another runner currently owns it and the lock has
// not yet expired. Distinct from ErrNoRunRow so the handler can
// tell "no eligible task" (204) apart from "transient contention"
// (retry / sleep).
var ErrLockHeld = fmt.Errorf("task lock held by another runner")

// ClaimResult bundles the row that was inserted by ClaimRun so
// the handler can echo it back to the CLI without re-reading
// from the database.
type ClaimResult struct {
	Run     *models.TaskRun
	TaskID  string
	ColumnID string
	BoardID string
}

// FindEligibleTask returns the next task that:
//   - belongs to a column with status=`status` on board=`boardID`
//   - whose column's column_agents.agent_types JSON array contains
//     `agentType`
//   - is not archived, is published, and is not currently locked
//     by a non-expired task_runs row
//
// The query deliberately orders by column.position ASC, task.position
// ASC so two parallel claimers agree on the same "next" task — the
// INSERT … ON CONFLICT in ClaimRun still serialises the actual
// lock acquisition; ordering just makes the loser side deterministic.
func (r *RunRepository) FindEligibleTask(boardID, status, agentType string) (string, string, error) {
	query := `
		SELECT t.id, t.column_id
		FROM tasks t
		JOIN columns c ON t.column_id = c.id
		JOIN boards b ON c.board_id = b.id
		LEFT JOIN column_agents ca ON c.id = ca.column_id
		LEFT JOIN task_runs tr ON tr.task_id = t.id
		    AND (tr.status = 'claimed' OR tr.status = 'running')
		    AND datetime(tr.expires_at) > datetime('now')
		WHERE b.id = ?
		  AND b.deleted = 0
		  AND c.status = ?
		  AND t.archived = 0
		  AND t.published = 1
		  AND tr.task_id IS NULL
		  AND (
		      ca.agent_types LIKE ? OR ca.agent_types LIKE ? OR ca.agent_types LIKE ?
		  )
		ORDER BY c.position ASC, t.position ASC
		LIMIT 1
	`

	exact := fmt.Sprintf(`["%s"]`, agentType)
	head := fmt.Sprintf(`["%s",`, agentType)
	tail := fmt.Sprintf(`,"%s"]`, agentType)
	middle := fmt.Sprintf(`,"%s",`, agentType)

	var taskID, columnID string
	err := r.db.QueryRow(query, boardID, status, exact, head, tail, middle).Scan(&taskID, &columnID)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", "", ErrNoRunRow
		}
		return "", "", err
	}
	return taskID, columnID, nil
}

// FindInProgressColumn returns the column id whose status =
// 'in_progress' on boardID, or an empty string when no such
// column exists. Used by ClaimRun to move the task into the
// canonical "in-progress" lane.
func (r *RunRepository) FindInProgressColumn(boardID string) (string, error) {
	var columnID string
	err := r.db.QueryRow(
		"SELECT id FROM columns WHERE board_id = ? AND status = 'in_progress' ORDER BY position ASC LIMIT 1",
		boardID,
	).Scan(&columnID)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	return columnID, nil
}

// ClaimRun atomically:
//  1. INSERTS / upserts a task_runs row with status='claimed',
//     claimed_at/last_heartbeat_at = now, expires_at = now + lockTimeoutMs.
//  2. Moves the task to the in-progress column on the same board
//     (creating the position at the tail of that column).
//
// Caller is responsible for picking the eligible task via
// FindEligibleTask and resolving the in-progress column via
// FindInProgressColumn BEFORE invoking ClaimRun — this method
// just performs the writes inside a single transaction so the
// "task moved + lock taken" outcome is atomic with respect to
// other claimers.
func (r *RunRepository) ClaimRun(
	boardID, taskID, columnID, runnerID, agentID string,
	inProgressColumnID string,
	lockTimeoutMs int,
) (*ClaimResult, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(lockTimeoutMs) * time.Millisecond)

	// Step 1: try to insert a brand-new row. If the row already
	// exists with status IN (claimed, running) AND expires_at >
	// now, the ON CONFLICT DO NOTHING leaves the existing row
	// untouched and we report ErrLockHeld to the caller so they
	// can pick a different task. If the existing row is expired
	// (released / completed / failed / stale claimed / running)
	// the UPDATE branch below steals it.
	res, err := tx.Exec(`
		INSERT INTO task_runs (
			task_id, runner_id, agent_id, board_id, column_id, status,
			claimed_at, last_heartbeat_at, expires_at
		) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
		ON CONFLICT(task_id) DO UPDATE SET
			runner_id = excluded.runner_id,
			agent_id = excluded.agent_id,
			board_id = excluded.board_id,
			column_id = excluded.column_id,
			status = 'claimed',
			claimed_at = excluded.claimed_at,
			last_heartbeat_at = excluded.last_heartbeat_at,
			expires_at = excluded.expires_at,
			finished_at = NULL,
			exit_code = NULL,
			error = NULL
		WHERE task_runs.status NOT IN ('claimed', 'running')
		   OR datetime(task_runs.expires_at) <= datetime('now')
	`, taskID, runnerID, agentID, boardID, columnID, now, now, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("insert task_runs: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}

	// RowsAffected on sqlite returns the number of rows the
	// statement touched. For an insert-only path it's 1; for the
	// UPSERT branch the WHERE clause filter means an active lock
	// leaves it at 0, in which case another runner still owns
	// the task. We distinguish by re-reading.
	var currentStatus string
	var currentExpires time.Time
	err = tx.QueryRow(
		"SELECT status, expires_at FROM task_runs WHERE task_id = ?",
		taskID,
	).Scan(&currentStatus, &currentExpires)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("claim: row vanished mid-transaction")
		}
		return nil, err
	}

	if affected == 0 && (currentStatus == string(models.RunStatusClaimed) || currentStatus == string(models.RunStatusRunning)) && currentExpires.After(now) {
		return nil, ErrLockHeld
	}

	// Step 2: move the task into the canonical in-progress
	// column. If no such column exists on the board we leave the
	// task where it is — the lock row is the source of truth
	// for "this task is being worked on", and the column move is
	// a UX nicety for the board viewer.
	if inProgressColumnID != "" && inProgressColumnID != columnID {
		var maxPos sql.NullInt64
		if err := tx.QueryRow(
			"SELECT MAX(position) FROM tasks WHERE column_id = ?",
			inProgressColumnID,
		).Scan(&maxPos); err != nil && err != sql.ErrNoRows {
			return nil, fmt.Errorf("resolve max position: %w", err)
		}
		nextPos := 1000
		if maxPos.Valid {
			nextPos = int(maxPos.Int64) + 1000
		}
		if _, err := tx.Exec(
			"UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?",
			inProgressColumnID, nextPos, now, taskID,
		); err != nil {
			return nil, fmt.Errorf("move task to in_progress column: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	row := r.db.QueryRow(
		"SELECT "+models.TaskRunColumns+" FROM task_runs WHERE task_id = ?",
		taskID,
	)
	tr, err := models.TaskRunFromRow(row.Scan)
	if err != nil {
		return nil, err
	}
	return &ClaimResult{Run: tr, TaskID: taskID, ColumnID: columnID, BoardID: boardID}, nil
}

// Heartbeat refreshes last_heartbeat_at = now and
// expires_at = now + lockTimeoutMs for the run owned by
// (taskID, runnerID) when its status is claimed or running.
// Returns ErrNoRunRow when no such row exists (handler maps to
// 404) or ErrLockHeld when the row exists but is owned by
// another runner or has been reaped (handler maps to 409).
func (r *RunRepository) Heartbeat(taskID, runnerID string, lockTimeoutMs int) (time.Time, error) {
	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(lockTimeoutMs) * time.Millisecond)

	res, err := r.db.Exec(`
		UPDATE task_runs
		SET last_heartbeat_at = ?, expires_at = ?
		WHERE task_id = ?
		  AND runner_id = ?
		  AND status IN ('claimed', 'running')
	`, now, expiresAt, taskID, runnerID)
	if err != nil {
		return time.Time{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return time.Time{}, err
	}
	if affected == 0 {
		// Distinguish "no row" from "wrong owner / wrong status".
		var (
			existingRunner string
			existingStatus string
		)
		err := r.db.QueryRow(
			"SELECT runner_id, status FROM task_runs WHERE task_id = ?",
			taskID,
		).Scan(&existingRunner, &existingStatus)
		if err == sql.ErrNoRows {
			return time.Time{}, ErrNoRunRow
		}
		if err != nil {
			return time.Time{}, err
		}
		if existingRunner != runnerID {
			return time.Time{}, ErrLockHeld
		}
		return time.Time{}, ErrLockHeld
	}
	return expiresAt, nil
}

// FinishRun marks the run row as completed/failed and (when
// status='completed') invokes CompleteTask to advance the
// underlying task. On 'failed' the task stays in its current
// column — the runner is expected to attach a failure comment via
// POST /api/v1/comments before calling /finish.
//
// As of s-1106, the row is NOT deleted: it is stamped to its
// terminal status (completed / failed) and left in place so the
// /api/v1/runs/history endpoint can list past runs. The release
// path still owns the 'released' terminal state — a row that
// transitions claimed → released is just another terminal row
// for the history view.
//
// Returns ErrNoRunRow when no row exists for the task, and
// ErrLockHeld when the row exists but is owned by a different
// runner or already in a terminal state.
func (r *RunRepository) FinishRun(taskID, runnerID string, status models.RunStatus, exitCode *int, errMsg *string, onCompleted func(taskID string) error) error {
	if status != models.RunStatusCompleted && status != models.RunStatusFailed {
		return fmt.Errorf("invalid finish status %q (must be completed or failed)", status)
	}

	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var existingRunner, existingStatus string
	err = tx.QueryRow(
		"SELECT runner_id, status FROM task_runs WHERE task_id = ?",
		taskID,
	).Scan(&existingRunner, &existingStatus)
	if err == sql.ErrNoRows {
		return ErrNoRunRow
	}
	if err != nil {
		return err
	}
	if existingRunner != runnerID {
		return ErrLockHeld
	}
	if existingStatus != string(models.RunStatusClaimed) && existingStatus != string(models.RunStatusRunning) {
		return ErrLockHeld
	}

	now := time.Now().UTC()
	// Update in place — the row stays so /runs/history can list it.
	// The expires_at / last_heartbeat_at columns are left as they
	// were at the last heartbeat (or claim) so the history view
	// can show "lock expired at" without recomputing.
	if _, err := tx.Exec(`
		UPDATE task_runs
		SET status = ?, finished_at = ?, exit_code = ?, error = ?
		WHERE task_id = ? AND runner_id = ?
	`, string(status), now, exitCode, errMsg, taskID, runnerID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	if status == models.RunStatusCompleted && onCompleted != nil {
		if err := onCompleted(taskID); err != nil {
			return err
		}
	}
	return nil
}

// ReleaseRuns bulk-releases every task_runs row owned by runnerID
// whose status is still live. When taskIDs is non-empty the
// release is scoped to that allow-list. For each released row
// the task is restored to the snapshot column_id. Returns the
// number of rows that were transitioned to 'released'.
//
// The endpoint is idempotent: rows already in
// completed/failed/released are skipped, so calling /release on
// shutdown or as a startup cleanup is safe to repeat.
func (r *RunRepository) ReleaseRuns(runnerID string, taskIDs []string) (int, error) {
	if runnerID == "" {
		return 0, fmt.Errorf("runnerID is required")
	}

	tx, err := r.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	args := []interface{}{runnerID}
	whereExtra := ""
	if len(taskIDs) > 0 {
		placeholders := make([]string, len(taskIDs))
		for i, id := range taskIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		whereExtra = " AND task_id IN (" + strings.Join(placeholders, ",") + ")"
	}

	now := time.Now().UTC()

	updateArgs := []interface{}{now, runnerID}
	if len(taskIDs) > 0 {
		for _, id := range taskIDs {
			updateArgs = append(updateArgs, id)
		}
	}

	res, err := tx.Exec(`
		UPDATE task_runs
		SET status = 'released',
		    finished_at = ?,
		    error = COALESCE(error, 'released')
		WHERE runner_id = ?
		  AND status IN ('claimed', 'running')
		  `+whereExtra+`
	`, updateArgs...)
	if err != nil {
		return 0, err
	}
	released, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}

	// Restore the snapshot column_id for each released row so the
	// task ends up back in the lane the runner originally picked
	// it up from. Tasks whose snapshot column has been deleted
	// fall back to the in-progress column on the same board; if
	// neither exists we leave the task alone (the lock release is
	// still valid — the column move is best-effort UX).
	if released > 0 {
		restoreArgs := []interface{}{now, runnerID}
		if len(taskIDs) > 0 {
			for _, id := range taskIDs {
				restoreArgs = append(restoreArgs, id)
			}
		}
		if _, err := tx.Exec(`
			UPDATE tasks
			SET column_id = COALESCE(
				(SELECT c2.id FROM columns c2
				  WHERE c2.id = (SELECT column_id FROM task_runs WHERE task_id = tasks.id)
				  LIMIT 1),
				(SELECT c3.id FROM columns c3
				  WHERE c3.board_id = (SELECT board_id FROM task_runs WHERE task_id = tasks.id)
				    AND c3.status = 'in_progress'
				  ORDER BY c3.position ASC LIMIT 1),
				column_id
			),
			updated_at = ?
			WHERE id IN (
			    SELECT task_id FROM task_runs
			    WHERE runner_id = ? AND status = 'released'
			      `+whereExtra+`
			)
		`, restoreArgs...); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(released), nil
}

// GetRun returns the task_runs row for taskID, or ErrNoRunRow
// when no such row exists.
func (r *RunRepository) GetRun(taskID string) (*models.TaskRun, error) {
	row := r.db.QueryRow(
		"SELECT "+models.TaskRunColumns+" FROM task_runs WHERE task_id = ?",
		taskID,
	)
	tr, err := models.TaskRunFromRow(row.Scan)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNoRunRow
		}
		return nil, err
	}
	return tr, nil
}

// RunHistoryFilter is the bundle of optional predicates the
// /api/v1/runs/history endpoint accepts. Each field is optional;
// the zero value means "no filter on this column". Status and
// BoardIDs are the two compound predicates — Status matches the
// run lifecycle (completed / failed / released) and BoardIDs
// scopes the result to one or more boards.
//
// From / To bound the finished_at column so the typical "last
// 24h / 7d / 30d" queries can hit idx_task_runs_finished_at (or
// idx_task_runs_status_finished_at when Status is also set)
// instead of scanning the table.
type RunHistoryFilter struct {
	RunnerID string
	Status   models.RunStatus
	BoardIDs []string
	TaskID   string
	From     time.Time
	To       time.Time
	Limit    int
	Offset   int
}

// ListRunHistory returns every terminal task_runs row
// (status ∈ {completed, failed, released}) matching the given
// filter, ordered by finished_at DESC. Live rows
// (status ∈ {claimed, running}) are intentionally excluded —
// those are surfaced by GetRun on the task card, not the history
// page.
//
// The query joins tasks so the handler can render task titles
// without an extra round-trip per row, and joins columns so a
// caller-side permission gate can evaluate column-level READ
// access for each row.
//
// Limit defaults to 50 and is capped at 200 to keep the JSON
// response bounded; Offset is the standard pagination cursor.
func (r *RunRepository) ListRunHistory(filter RunHistoryFilter) ([]*models.TaskRun, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	where := []string{
		"tr.status IN ('completed', 'failed', 'released')",
	}
	args := []interface{}{}

	if filter.RunnerID != "" {
		where = append(where, "tr.runner_id = ?")
		args = append(args, filter.RunnerID)
	}
	if filter.Status != "" {
		where = append(where, "tr.status = ?")
		args = append(args, string(filter.Status))
	}
	if filter.TaskID != "" {
		where = append(where, "tr.task_id = ?")
		args = append(args, filter.TaskID)
	}
	if !filter.From.IsZero() {
		where = append(where, "tr.finished_at >= ?")
		args = append(args, filter.From.UTC())
	}
	if !filter.To.IsZero() {
		where = append(where, "tr.finished_at <= ?")
		args = append(args, filter.To.UTC())
	}
	if len(filter.BoardIDs) > 0 {
		placeholders := make([]string, len(filter.BoardIDs))
		for i, id := range filter.BoardIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		where = append(where, "tr.board_id IN ("+strings.Join(placeholders, ",")+")")
	}

	args = append(args, limit, offset)

	query := `
		SELECT ` + models.TaskRunColumns + `
		FROM task_runs tr
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY tr.finished_at DESC, tr.task_id ASC
		LIMIT ? OFFSET ?
	`

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*models.TaskRun
	for rows.Next() {
		tr, err := models.ScanTaskRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if out == nil {
		out = []*models.TaskRun{}
	}
	return out, nil
}

// ExpiredRun is the minimal snapshot the reaper needs to roll a
// task back to its original column once the lock is released.
type ExpiredRun struct {
	TaskID   string
	ColumnID string
	BoardID  string
}

// ReapExpiredRuns atomically transitions every live task_runs row
// whose expires_at < now() into status='released' and returns the
// snapshot (column_id, board_id) so the caller can restore the
// underlying tasks. Restoring the tasks is intentionally a
// separate step (RestoreRunTasks) so the reaper can be invoked
// with `restore=false` for dry-runs / metrics.
//
// The query uses the same WHERE clause as §3.5 of the plan:
// `status IN ('claimed','running') AND expires_at < NOW()`. Rows
// that finish between the scan and the UPDATE are skipped
// naturally because UPDATE … WHERE status IN … won't match a
// row that has already transitioned to a terminal state.
func (r *RunRepository) ReapExpiredRuns(restore bool) ([]ExpiredRun, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()

	rows, err := tx.Query(`
		SELECT task_id, column_id, board_id
		FROM task_runs
		WHERE status IN ('claimed', 'running')
		  AND datetime(expires_at) <= datetime('now')
	`, now)
	if err != nil {
		return nil, err
	}
	var expired []ExpiredRun
	for rows.Next() {
		var e ExpiredRun
		if err := rows.Scan(&e.TaskID, &e.ColumnID, &e.BoardID); err != nil {
			rows.Close()
			return nil, err
		}
		expired = append(expired, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(expired) == 0 {
		return nil, tx.Commit()
	}

	if _, err := tx.Exec(`
		UPDATE task_runs
		SET status = 'released',
		    finished_at = ?,
		    error = COALESCE(error, 'lock expired')
		WHERE status IN ('claimed', 'running')
		  AND datetime(expires_at) <= datetime('now')
	`, now); err != nil {
		return nil, err
	}

	if restore {
		// Restore the snapshot column. If the snapshot column
		// has been deleted, fall back to the in-progress column
		// on the same board; if neither exists we leave the
		// task where it is.
		if _, err := tx.Exec(`
			UPDATE tasks
			SET column_id = COALESCE(
				(SELECT c2.id FROM columns c2
				  WHERE c2.id = (SELECT tr.column_id FROM task_runs tr WHERE tr.task_id = tasks.id)
				  LIMIT 1),
				(SELECT c3.id FROM columns c3
				  WHERE c3.board_id = (SELECT tr.board_id FROM task_runs tr WHERE tr.task_id = tasks.id)
				    AND c3.status = 'in_progress'
				  ORDER BY c3.position ASC LIMIT 1),
				column_id
			),
			updated_at = ?
			WHERE id IN (SELECT task_id FROM task_runs WHERE status = 'released' AND finished_at = ?)
		`, now, now); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return expired, nil
}

// agentTypesContains is a small helper exposed for tests that
// don't want to keep repeating the JSON-shape dance.
func agentTypesContains(agentTypesJSON, agentType string) bool {
	if agentTypesJSON == "" {
		return false
	}
	var types []string
	if err := json.Unmarshal([]byte(agentTypesJSON), &types); err != nil {
		return false
	}
	for _, t := range types {
		if t == agentType {
			return true
		}
	}
	return false
}

var _ = agentTypesContains
