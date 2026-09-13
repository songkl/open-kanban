package handlers

import (
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"open-kanban/internal/models"
	"open-kanban/internal/services"
)

// publishTaskCreated is the single emission point for
// task.created. Replaces the previous webhookSvc.NotifyTaskCreated
// call (tasks_crud.go:67) so the EventCenter dispatcher owns the
// fan-out. Fired asynchronously so a slow / full bus never
// blocks the HTTP response.
//
// boardID is the board the task's column belongs to — looked
// up on the request goroutine because the dispatcher needs it
// for §3.2 filter evaluation.
func publishTaskCreated(db *sql.DB, task *models.Task, actorID string) {
	if task == nil {
		return
	}
	boardID := boardIDForColumn(db, task.ColumnID)
	columnName := getColumnName(db, task.ColumnID)
	payload := services.TaskPayload{
		ID:          task.ID,
		Title:       task.Title,
		ColumnID:    task.ColumnID,
		ColumnName:  columnName,
		Priority:    task.Priority,
		Assignee:    derefString(task.Assignee),
		Description: derefString(task.Description),
		CreatedBy:   task.CreatedBy,
		CreatedAt:   cloneTime(task.CreatedAt),
		UpdatedAt:   cloneTime(task.UpdatedAt),
	}
	ev := services.NewTaskCreatedEvent(payload, boardID, task.CreatedAt)
	publishEvent(ev)
	_ = actorID
}

// publishTaskUpdates fans out the three task.* events that
// the UpdateTask handler can produce (task.updated,
// task.moved, task.assigned). Each event has its own call site
// so the spec's "同一 HTTP 请求只 publish 一次" rule per
// emission point is satisfied by construction.
//
// fromColumnID is the column the task was in BEFORE the update
// — used to fire task.moved iff the request moved the task
// across a column boundary. previousAssignee is the task's
// assignee value BEFORE the update (nil if the column was
// previously NULL) — passed in by the handler so the helper
// does not have to issue a second SELECT. preTask is the
// pre-update task snapshot used to compute the diff entries
// for task.updated.
func publishTaskUpdates(db *sql.DB, task *models.Task, fromColumnID string, req UpdateTaskRequest, previousAssignee *string, preTask *preUpdateTaskSnapshot) {
	if task == nil {
		return
	}

	boardID := boardIDForColumn(db, task.ColumnID)
	columnName := getColumnName(db, task.ColumnID)
	payload := services.TaskPayload{
		ID:          task.ID,
		Title:       task.Title,
		ColumnID:    task.ColumnID,
		ColumnName:  columnName,
		Priority:    task.Priority,
		Assignee:    derefString(task.Assignee),
		Description: derefString(task.Description),
		CreatedBy:   task.CreatedBy,
		CreatedAt:   cloneTime(task.CreatedAt),
		UpdatedAt:   cloneTime(task.UpdatedAt),
	}

	changeEntries := diffChangeEntries(req, preTask, fromColumnID, db)
	if len(changeEntries) > 0 {
		ev := services.NewTaskUpdatedEvent(payload, boardID, changeEntries, task.UpdatedAt)
		publishEvent(ev)
	}

	if req.ColumnID != "" && req.ColumnID != fromColumnID {
		ev := services.NewTaskMovedEvent(payload, boardID, fromColumnID, task.UpdatedAt)
		publishEvent(ev)
	}

	if req.Assignee != nil && assigneeChanged(req.Assignee, previousAssignee) {
		ev := services.NewTaskAssignedEvent(payload, boardID, previousAssignee, task.UpdatedAt)
		publishEvent(ev)
	}
}

// publishTaskDeleted is the single emission point for
// task.deleted. Captures the pre-delete snapshot (title +
// column) so receivers can render a useful payload even
// though the task row is gone after this call returns.
func publishTaskDeleted(db *sql.DB, taskID, columnID, taskTitle string) {
	boardID := boardIDForColumn(db, columnID)
	columnName := getColumnName(db, columnID)
	payload := services.TaskPayload{
		ID:         taskID,
		Title:      taskTitle,
		ColumnID:   columnID,
		ColumnName: columnName,
	}
	ev := services.NewTaskDeletedEvent(payload, boardID, time.Now().UTC())
	publishEvent(ev)
}

// publishTaskMoved is the shared helper for the task.moved
// events fired from both UpdateTask (column change on update)
// and CompleteTask (the post-completion move). One call site
// per HTTP request — the two callers each invoke this
// exactly once.
func publishTaskMoved(db *sql.DB, taskID, title, newColumnID, fromColumnID, priority, assignee string) {
	boardID := boardIDForColumn(db, newColumnID)
	columnName := getColumnName(db, newColumnID)
	payload := services.TaskPayload{
		ID:         taskID,
		Title:      title,
		ColumnID:   newColumnID,
		ColumnName: columnName,
		Priority:   priority,
		Assignee:   assignee,
	}
	ev := services.NewTaskMovedEvent(payload, boardID, fromColumnID, time.Now().UTC())
	publishEvent(ev)
}

// publishTaskCompleted fires the task.completed event from
// CompleteTask when the new column's status is "done".
func publishTaskCompleted(db *sql.DB, taskID, title, newColumnID, priority, assignee string) {
	boardID := boardIDForColumn(db, newColumnID)
	columnName := getColumnName(db, newColumnID)
	payload := services.TaskPayload{
		ID:         taskID,
		Title:      title,
		ColumnID:   newColumnID,
		ColumnName: columnName,
		Priority:   priority,
		Assignee:   assignee,
	}
	ev := services.NewTaskCompletedEvent(payload, boardID, time.Now().UTC())
	publishEvent(ev)
}

// publishTaskCommented is the CreateComment emission point.
// Replaces the legacy webhookSvc.NotifyTaskCommented call
// (comments.go:187). The task snapshot is looked up lazily on
// the goroutine so a slow SQLite read never delays the HTTP
// response.
func publishTaskCommented(db *sql.DB, taskID, commentID, content, author, userID string, createdAt sql.NullTime) {
	var title, columnID, priority string
	var assignee *string
	if err := db.QueryRow(
		"SELECT title, column_id, priority, assignee FROM tasks WHERE id = ?", taskID,
	).Scan(&title, &columnID, &priority, &assignee); err != nil {
		slog.Warn("publishTaskCommented: failed to load task snapshot",
			"task_id", taskID, "error", err)
		return
	}
	boardID := boardIDForColumn(db, columnID)
	columnName := getColumnName(db, columnID)
	payload := services.TaskPayload{
		ID:         taskID,
		Title:      title,
		ColumnID:   columnID,
		ColumnName: columnName,
		Priority:   priority,
		Assignee:   derefString(assignee),
	}
	ts := commentCreatedAt(createdAt)
	ev := services.NewTaskCommentedEvent(payload, boardID, services.CommentPayload{
		ID:        commentID,
		Content:   content,
		Author:    author,
		UserID:    userID,
		TaskID:    taskID,
		CreatedAt: ts,
	}, ts)
	publishEvent(ev)
}

// publishBoardCreated is the CreateBoard emission point for
// board.created. board.deleted is intentionally not emitted
// because the catalogue (§3) does not list it; the soft-delete
// path in boards_crud.go flips the deleted flag without a fan-out.
func publishBoardCreated(boardID, name, shortAlias, description string, createdAt, updatedAt sql.NullTime) {
	payload := services.BoardPayload{
		ID:          boardID,
		Name:        name,
		ShortAlias:  shortAlias,
		Description: description,
		CreatedAt:   nullTimePtr(createdAt),
		UpdatedAt:   nullTimePtr(updatedAt),
	}
	ev := services.NewBoardCreatedEvent(payload, time.Now().UTC())
	publishEvent(ev)
}

// publishBoardUpdated is the UpdateBoard emission point for
// board.updated. Only fires when at least one tracked field
// changed (caller is responsible for the empty-changes
// short-circuit so the catalogue contract holds: a no-op
// PATCH must not produce a board.updated event).
func publishBoardUpdated(boardID, name, shortAlias, description string, changes []services.ChangePayload, updatedAt sql.NullTime) {
	if len(changes) == 0 {
		return
	}
	payload := services.BoardPayload{
		ID:          boardID,
		Name:        name,
		ShortAlias:  shortAlias,
		Description: description,
		UpdatedAt:   nullTimePtr(updatedAt),
	}
	ev := services.NewBoardUpdatedEvent(payload, changes, time.Now().UTC())
	publishEvent(ev)
}

// publishColumnCreated is the CreateColumn emission point for
// column.created.
func publishColumnCreated(columnID, name, boardID string, position int, color string, status *string) {
	payload := services.ColumnPayload{
		ID:       columnID,
		Name:     name,
		BoardID:  boardID,
		Position: position,
		Color:    color,
		Status:   status,
	}
	ev := services.NewColumnCreatedEvent(payload, time.Now().UTC())
	publishEvent(ev)
}

// publishColumnUpdated is the UpdateColumn emission point for
// column.updated. Only fires when at least one tracked field
// changed.
func publishColumnUpdated(columnID, name, boardID string, position int, color string, status *string, changes []services.ChangePayload) {
	if len(changes) == 0 {
		return
	}
	payload := services.ColumnPayload{
		ID:       columnID,
		Name:     name,
		BoardID:  boardID,
		Position: position,
		Color:    color,
		Status:   status,
	}
	ev := services.NewColumnUpdatedEvent(payload, changes, time.Now().UTC())
	publishEvent(ev)
}

// publishColumnDeleted is the DeleteColumn emission point for
// column.deleted.
func publishColumnDeleted(columnID, name, boardID string, position int, color string, status *string) {
	payload := services.ColumnPayload{
		ID:       columnID,
		Name:     name,
		BoardID:  boardID,
		Position: position,
		Color:    color,
		Status:   status,
	}
	ev := services.NewColumnDeletedEvent(payload, time.Now().UTC())
	publishEvent(ev)
}

// publishEvent is the single front door handlers use to push
// events onto the bus. The fire-and-forget goroutine matches
// the legacy `go webhookSvc.NotifyXxx(...)` pattern so an
// HTTP request never blocks on the dispatcher / worker pool.
// Publish itself is synchronous (plan §5 — "synchronous
// enqueue"), so this is at-most-once per call site per request.
func publishEvent(ev services.Event) {
	if ev == nil {
		return
	}
	bus := services.GetDefaultEventBus()
	go func() {
		if err := bus.Publish(ev); err != nil {
			slog.Warn("publishEvent: bus publish failed",
				"event_type", ev.EventType(),
				"envelope_id", ev.EnvelopeID(),
				"error", err)
		}
	}()
}

// boardIDForColumn looks up the board that owns the given
// column. Returns "" when the column has been deleted between
// the trigger and the lookup; the dispatcher treats "" as
// "this event has no value for the boardIds dimension" and
// skips filter evaluation accordingly.
func boardIDForColumn(db *sql.DB, columnID string) string {
	if columnID == "" {
		return ""
	}
	var boardID string
	if err := db.QueryRow(
		"SELECT board_id FROM columns WHERE id = ?", columnID,
	).Scan(&boardID); err != nil {
		return ""
	}
	return boardID
}

// taskAssigneeBeforeUpdate fetches the task's assignee value
// in a single SELECT so the UpdateTask handler can hand the
// previous value to publishTaskUpdates without re-reading the
// row. Returns nil when the column was NULL.
func taskAssigneeBeforeUpdate(db *sql.DB, taskID string) *string {
	var assignee sql.NullString
	if err := db.QueryRow(
		"SELECT assignee FROM tasks WHERE id = ?", taskID,
	).Scan(&assignee); err != nil {
		return nil
	}
	if !assignee.Valid {
		return nil
	}
	v := assignee.String
	return &v
}

// preUpdateTaskSnapshot captures the diff-relevant fields of
// the task row before UpdateTask applies the request. Used by
// diffChangeEntries to compute the change set; without this,
// comparing req against the post-update task snapshot would
// miss every transition (request == post-update by
// construction).
type preUpdateTaskSnapshot struct {
	Title       string
	Description string
	Priority    string
	Assignee    string
}

// taskSnapshotForUpdate reads the diff-relevant columns of a
// task in a single SELECT. The fields captured here are the
// ones diffChangeEntries knows how to translate into
// ChangePayload entries; the task service's changes slice
// additionally covers meta/position/published/agent fields
// which we deliberately omit from the event payload (those
// aren't part of the §3 catalogue schema for task.updated).
func taskSnapshotForUpdate(db *sql.DB, taskID string) *preUpdateTaskSnapshot {
	out := &preUpdateTaskSnapshot{}
	var description, assignee sql.NullString
	if err := db.QueryRow(
		"SELECT title, description, priority, assignee FROM tasks WHERE id = ?", taskID,
	).Scan(&out.Title, &description, &out.Priority, &assignee); err != nil {
		return out
	}
	if description.Valid {
		out.Description = description.String
	}
	if assignee.Valid {
		out.Assignee = assignee.String
	}
	return out
}

// diffChangeEntries compares the request against the
// pre-update task snapshot and produces the structured
// ChangePayload entries the dispatcher renders under
// data.changes[]. Each entry names the dotted field, the
// previous value, and the new value.
func diffChangeEntries(req UpdateTaskRequest, pre *preUpdateTaskSnapshot, fromColumnID string, db *sql.DB) []services.ChangePayload {
	if pre == nil {
		return nil
	}
	out := make([]services.ChangePayload, 0, 4)
	if req.Title != "" && req.Title != pre.Title {
		out = append(out, services.ChangePayload{Field: "title", From: pre.Title, To: req.Title})
	}
	if req.Description != nil && *req.Description != pre.Description {
		out = append(out, services.ChangePayload{Field: "description", From: pre.Description, To: *req.Description})
	}
	if req.Priority != "" && req.Priority != pre.Priority {
		out = append(out, services.ChangePayload{Field: "priority", From: pre.Priority, To: req.Priority})
	}
	if req.Assignee != nil && *req.Assignee != pre.Assignee {
		out = append(out, services.ChangePayload{Field: "assignee", From: pre.Assignee, To: *req.Assignee})
	}
	if req.ColumnID != "" && req.ColumnID != fromColumnID {
		fromName := getColumnName(db, fromColumnID)
		toName := getColumnName(db, req.ColumnID)
		out = append(out, services.ChangePayload{Field: "columnId", From: fromName, To: toName})
	}
	return out
}

// assigneeChanged returns true when the new and previous
// assignee values differ. Both nil → unchanged; one nil and
// the other set → changed (covers the null→user and
// user→null cases called out in plan §3).
func assigneeChanged(current, previous *string) bool {
	if current == nil && previous == nil {
		return false
	}
	if current == nil || previous == nil {
		return true
	}
	return *current != *previous
}

// commentCreatedAt normalises a sql.NullTime into a
// time.Time. Falls back to time.Now() so the event timestamp
// is always set even when the column read returned NULL.
func commentCreatedAt(t sql.NullTime) time.Time {
	if t.Valid {
		return t.Time
	}
	return time.Now().UTC()
}

// nullTimePtr converts a sql.NullTime into a *time.Time the
// JSON encoder can render as either an RFC3339 string or a
// JSON null (per TaskPayload.CreatedAt's `omitempty` tag —
// nil pointer → field omitted).
func nullTimePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

// cloneTime copies a time.Time so the receiver can't
// accidentally mutate the original task's timestamps via
// the pointer held inside TaskPayload.
func cloneTime(t time.Time) *time.Time {
	v := t
	return &v
}

// boardChangeEntries translates the UpdateBoard request into
// the structured ChangePayload array. Used by publishBoardUpdated.
func boardChangeEntries(req UpdateBoardRequest, oldName, oldDesc string) []services.ChangePayload {
	out := make([]services.ChangePayload, 0, 2)
	if req.Name != "" && req.Name != oldName {
		out = append(out, services.ChangePayload{Field: "name", From: oldName, To: req.Name})
	}
	if req.Description != oldDesc {
		out = append(out, services.ChangePayload{Field: "description", From: oldDesc, To: req.Description})
	}
	return out
}

// columnChangeEntries translates the UpdateColumn request into
// the structured ChangePayload array. Used by publishColumnUpdated.
func columnChangeEntries(req UpdateColumnRequest, oldColumn struct {
	Name         string
	Status       *string
	Position     int
	Color        string
	Description  string
	OwnerAgentId *string
}) []services.ChangePayload {
	out := make([]services.ChangePayload, 0, 6)
	if req.Name != "" && req.Name != oldColumn.Name {
		out = append(out, services.ChangePayload{Field: "name", From: oldColumn.Name, To: req.Name})
	}
	if req.Status != "" {
		oldStatus := ""
		if oldColumn.Status != nil {
			oldStatus = *oldColumn.Status
		}
		if req.Status != oldStatus {
			out = append(out, services.ChangePayload{Field: "status", From: oldStatus, To: req.Status})
		}
	}
	if req.Position != nil && *req.Position != oldColumn.Position {
		out = append(out, services.ChangePayload{
			Field: "position",
			From:  fmt.Sprintf("%d", oldColumn.Position),
			To:    fmt.Sprintf("%d", *req.Position),
		})
	}
	if req.Color != "" && req.Color != oldColumn.Color {
		out = append(out, services.ChangePayload{Field: "color", From: oldColumn.Color, To: req.Color})
	}
	if req.Description != "" && req.Description != oldColumn.Description {
		out = append(out, services.ChangePayload{Field: "description", From: oldColumn.Description, To: req.Description})
	}
	if req.OwnerAgentId != nil {
		oldOwner := ""
		if oldColumn.OwnerAgentId != nil {
			oldOwner = *oldColumn.OwnerAgentId
		}
		if *req.OwnerAgentId != oldOwner {
			out = append(out, services.ChangePayload{Field: "ownerAgentId", From: oldOwner, To: *req.OwnerAgentId})
		}
	}
	return out
}
