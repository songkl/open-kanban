package models

import (
	"database/sql"
	"time"
)

// RunStatus is the lifecycle state of a task_runs row. See
// devDoc/CLI_RUNNER_PLAN_2026-09-12.md §3.3 and
// devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml `RunStatus`. Only
// `claimed` / `running` are live states — the others are terminal
// (or transient on the way to deletion) and only `released` ever
// outlives the underlying task.
type RunStatus string

const (
	// RunStatusClaimed is written by the claim handler and stays
	// until the runner starts processing (future start endpoint) or
	// the reaper notices the lock has expired.
	RunStatusClaimed RunStatus = "claimed"
	// RunStatusRunning is reserved for a future
	// `POST /runs/:id/start` transition; not used by v1.
	RunStatusRunning RunStatus = "running"
	// RunStatusCompleted is written by the finish handler and the
	// row is deleted immediately afterwards; it exists transiently
	// so activity / audit consumers can read the final state.
	RunStatusCompleted RunStatus = "completed"
	// RunStatusFailed mirrors RunStatusCompleted for the failure
	// path — same lifetime, different terminal cause.
	RunStatusFailed RunStatus = "failed"
	// RunStatusReleased is written by the reaper (§3.5) when a
	// lock expires; unlike completed/failed it persists so a board
	// viewer can see "this task was claimed and given up on".
	RunStatusReleased RunStatus = "released"
)

// ValidRunStatuses is the canonical set of accepted status strings,
// useful for handler-side validation before we hit the database.
var ValidRunStatuses = map[RunStatus]struct{}{
	RunStatusClaimed:   {},
	RunStatusRunning:   {},
	RunStatusCompleted: {},
	RunStatusFailed:    {},
	RunStatusReleased:  {},
}

// IsLive returns true for the two non-terminal states a task_runs
// row can be in while its lock is still considered held by the
// owning runner. The reaper and heartbeat handler both filter on
// this predicate; keeping it on the model avoids drifting the two
// copies.
func (s RunStatus) IsLive() bool {
	return s == RunStatusClaimed || s == RunStatusRunning
}

// TaskRun is the server-managed per-task lock row backing the CLI
// runner claim/heartbeat lifecycle (see CLI_RUNNER_PLAN_2026-09-12
// §3.3). One row per task currently held by a runner; the primary
// key is the task id, so the claim handler can use INSERT … ON
// CONFLICT to re-claim an expired row or fail-fast on a live lock.
//
// JSON tags match the TaskRun schema in
// CLI_RUNNER_OPENAPI_2026-09-12.yaml §TaskRun verbatim, including
// the optional finishedAt / exitCode / error fields; an empty
// (zero-value) pointer means "not yet finished" and is omitted from
// JSON to keep the live rows tidy.
type TaskRun struct {
	TaskID          string     `json:"taskId"`
	RunnerID        string     `json:"runnerId"`
	AgentID         string     `json:"agentId"`
	BoardID         string     `json:"boardId"`
	ColumnID        string     `json:"columnId"`
	Status          RunStatus  `json:"status"`
	ClaimedAt       time.Time  `json:"claimedAt"`
	LastHeartbeatAt time.Time  `json:"lastHeartbeatAt"`
	ExpiresAt       time.Time  `json:"expiresAt"`
	FinishedAt      *time.Time `json:"finishedAt,omitempty"`
	ExitCode        *int       `json:"exitCode,omitempty"`
	Error           *string    `json:"error,omitempty"`
}

// TaskRunColumns is the canonical SELECT list for task_runs rows,
// shared between the scan helpers and the repository so we don't
// drift between read paths.
const TaskRunColumns = `task_id, runner_id, agent_id, board_id, column_id, status,
		claimed_at, last_heartbeat_at, expires_at, finished_at, exit_code, error`

// TaskRunFromRow scans a single task_runs row produced by a SELECT
// using TaskRunColumns into a TaskRun. Nullable columns (finished_at,
// exit_code, error) are mapped to *time.Time / *int / *string so the
// zero value faithfully means "not set".
//
// Use this in repository code whenever you already have *sql.Row /
// *sql.Rows in hand. For higher-level "scan N rows" loops prefer
// ScanTaskRun so the boilerplate stays in one place.
func TaskRunFromRow(scan func(dest ...any) error) (*TaskRun, error) {
	var (
		tr         TaskRun
		finishedAt sql.NullTime
		exitCode   sql.NullInt64
		errMsg     sql.NullString
		status     string
	)
	if err := scan(
		&tr.TaskID, &tr.RunnerID, &tr.AgentID, &tr.BoardID, &tr.ColumnID, &status,
		&tr.ClaimedAt, &tr.LastHeartbeatAt, &tr.ExpiresAt,
		&finishedAt, &exitCode, &errMsg,
	); err != nil {
		return nil, err
	}
	tr.Status = RunStatus(status)
	if finishedAt.Valid {
		t := finishedAt.Time
		tr.FinishedAt = &t
	}
	if exitCode.Valid {
		v := int(exitCode.Int64)
		tr.ExitCode = &v
	}
	if errMsg.Valid {
		s := errMsg.String
		tr.Error = &s
	}
	return &tr, nil
}

// ScanTaskRun is a thin convenience wrapper around TaskRunFromRow
// for *sql.Rows usage. It keeps repository code free of the
// ErrRows scan dance and lets the model own the column ordering.
func ScanTaskRun(rows *sql.Rows) (*TaskRun, error) {
	return TaskRunFromRow(rows.Scan)
}

// ToTaskRun is the reverse direction: build a TaskRun from already
// in-memory fields. Useful for handler code that has just stamped a
// claim and wants to return the row without re-reading it from the
// database. It does NOT consult the database and does not validate
// the Status — callers that care should check ValidRunStatuses
// themselves.
func ToTaskRun(
	taskID, runnerID, agentID, boardID, columnID string,
	status RunStatus,
	claimedAt, lastHeartbeatAt, expiresAt time.Time,
) *TaskRun {
	return &TaskRun{
		TaskID:          taskID,
		RunnerID:        runnerID,
		AgentID:         agentID,
		BoardID:         boardID,
		ColumnID:        columnID,
		Status:          status,
		ClaimedAt:       claimedAt,
		LastHeartbeatAt: lastHeartbeatAt,
		ExpiresAt:       expiresAt,
	}
}
