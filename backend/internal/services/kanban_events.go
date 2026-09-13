package services

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

// ----------------------------------------------------------------------
// Event payload shapes (plan §3 catalogue)
// ----------------------------------------------------------------------

// TaskPayload is the `data.task` shape every task.* event
// publishes under envelope.data.task. Mirrors the existing
// WebhookTask shape so receivers that consumed the legacy
// payload continue to work unchanged after the migration.
type TaskPayload struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	ColumnID    string     `json:"columnId"`
	ColumnName  string     `json:"columnName,omitempty"`
	Priority    string     `json:"priority"`
	Assignee    string     `json:"assignee,omitempty"`
	Description string     `json:"description,omitempty"`
	CreatedBy   string     `json:"createdBy,omitempty"`
	CreatedAt   *time.Time `json:"createdAt,omitempty"`
	UpdatedAt   *time.Time `json:"updatedAt,omitempty"`
}

// BoardPayload is the `data.board` shape on board.created /
// board.updated events.
type BoardPayload struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	ShortAlias  string     `json:"shortAlias,omitempty"`
	Description string     `json:"description,omitempty"`
	CreatedAt   *time.Time `json:"createdAt,omitempty"`
	UpdatedAt   *time.Time `json:"updatedAt,omitempty"`
}

// ColumnPayload is the `data.column` shape on column.* events.
type ColumnPayload struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	BoardID  string  `json:"boardId"`
	Position int     `json:"position"`
	Color    string  `json:"color,omitempty"`
	Status   *string `json:"status,omitempty"`
}

// CommentPayload is the `data.comment` shape on task.commented
// events.
type CommentPayload struct {
	ID        string    `json:"id"`
	Content   string    `json:"content"`
	Author    string    `json:"author,omitempty"`
	UserID    string    `json:"userId,omitempty"`
	TaskID    string    `json:"taskId"`
	CreatedAt time.Time `json:"createdAt"`
}

// ChangePayload describes one field transition under
// `data.changes[]` on *.updated events. Field is the dotted
// field name (e.g. "title", "assignee"), From/To hold the
// previous / next values rendered as strings so receivers can
// display the transition without needing the original Go type.
type ChangePayload struct {
	Field string `json:"field"`
	From  string `json:"from"`
	To    string `json:"to"`
}

// TaskEventFilter exposes the dispatcher-relevant dimensions
// (board / column / priority / assignee) for the task.* events.
// BoardID / ColumnID are derived from the embedded TaskPayload
// fields so the dispatcher can evaluate per-webhook filters
// without a separate SQL lookup.
type TaskEventFilter struct {
	Task     TaskPayload
	BoardID  string
	ColumnID string
}

func (f TaskEventFilter) FilterBoardID() string  { return f.BoardID }
func (f TaskEventFilter) FilterColumnID() string { return f.ColumnID }
func (f TaskEventFilter) FilterPriority() string { return f.Task.Priority }
func (f TaskEventFilter) FilterAssignee() string { return f.Task.Assignee }

// ColumnEventFilter exposes the board dimension for column.*
// events. The dispatcher treats empty FilterColumnID /
// FilterPriority / FilterAssignee as "this event has no value
// for that dimension" so a webhook that declares a non-empty
// filter set for those categories never matches.
type ColumnEventFilter struct {
	BoardID string
}

func (f ColumnEventFilter) FilterBoardID() string  { return f.BoardID }
func (f ColumnEventFilter) FilterColumnID() string { return "" }
func (f ColumnEventFilter) FilterPriority() string { return "" }
func (f ColumnEventFilter) FilterAssignee() string { return "" }

// BoardEventFilter implements Filterable for board.created /
// board.updated. Plan §3.2 says board.* events carry no
// filter dimensions (the operator configures destinations
// globally for these events), so all accessors return "".
type BoardEventFilter struct{}

func (BoardEventFilter) FilterBoardID() string  { return "" }
func (BoardEventFilter) FilterColumnID() string { return "" }
func (BoardEventFilter) FilterPriority() string { return "" }
func (BoardEventFilter) FilterAssignee() string { return "" }

// ----------------------------------------------------------------------
// Concrete Event implementations
// ----------------------------------------------------------------------

// TaskCreatedEvent fires when a new task row is inserted
// (tasks_crud.go CreateTask). Payload root is { task }.
type TaskCreatedEvent struct {
	filter TaskEventFilter
	at     time.Time
}

func NewTaskCreatedEvent(task TaskPayload, boardID string, at time.Time) *TaskCreatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskCreatedEvent{
		filter: TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		at:     at,
	}
}

func (e *TaskCreatedEvent) EventType() string     { return "task.created" }
func (e *TaskCreatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskCreatedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskCreatedEvent) Data() any             { return ginH{"task": e.filter.Task} }
func (e *TaskCreatedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskCreatedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskCreatedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskCreatedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskUpdatedEvent fires when an existing task row is updated
// (tasks_crud.go UpdateTask) AND the update changed at least
// one tracked field. Payload root is { task, changes[] }.
type TaskUpdatedEvent struct {
	filter  TaskEventFilter
	changes []ChangePayload
	at      time.Time
}

func NewTaskUpdatedEvent(task TaskPayload, boardID string, changes []ChangePayload, at time.Time) *TaskUpdatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskUpdatedEvent{
		filter:  TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		changes: changes,
		at:      at,
	}
}

func (e *TaskUpdatedEvent) EventType() string     { return "task.updated" }
func (e *TaskUpdatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskUpdatedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskUpdatedEvent) Data() any {
	return ginH{"task": e.filter.Task, "changes": e.changes}
}
func (e *TaskUpdatedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskUpdatedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskUpdatedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskUpdatedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskMovedEvent fires when a task crosses a column boundary.
// Payload root is { task, fromColumnId, toColumnId }.
type TaskMovedEvent struct {
	filter        TaskEventFilter
	fromColumnID  string
	at            time.Time
}

func NewTaskMovedEvent(task TaskPayload, boardID, fromColumnID string, at time.Time) *TaskMovedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskMovedEvent{
		filter:       TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		fromColumnID: fromColumnID,
		at:           at,
	}
}

func (e *TaskMovedEvent) EventType() string     { return "task.moved" }
func (e *TaskMovedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskMovedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskMovedEvent) Data() any {
	return ginH{
		"task":         e.filter.Task,
		"fromColumnId": e.fromColumnID,
		"toColumnId":   e.filter.Task.ColumnID,
	}
}
func (e *TaskMovedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskMovedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskMovedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskMovedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskCompletedEvent fires when a task is moved into a column
// whose status is "done" (tasks_special.go CompleteTask).
// Payload root is { task }.
type TaskCompletedEvent struct {
	filter TaskEventFilter
	at     time.Time
}

func NewTaskCompletedEvent(task TaskPayload, boardID string, at time.Time) *TaskCompletedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskCompletedEvent{
		filter: TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		at:     at,
	}
}

func (e *TaskCompletedEvent) EventType() string     { return "task.completed" }
func (e *TaskCompletedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskCompletedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskCompletedEvent) Data() any             { return ginH{"task": e.filter.Task} }
func (e *TaskCompletedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskCompletedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskCompletedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskCompletedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskDeletedEvent fires when a task row is removed (soft-delete
// via tasks_crud.go DeleteTask). Payload root is { task } and
// carries the pre-delete task snapshot.
type TaskDeletedEvent struct {
	filter TaskEventFilter
	at     time.Time
}

func NewTaskDeletedEvent(task TaskPayload, boardID string, at time.Time) *TaskDeletedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskDeletedEvent{
		filter: TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		at:     at,
	}
}

func (e *TaskDeletedEvent) EventType() string     { return "task.deleted" }
func (e *TaskDeletedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskDeletedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskDeletedEvent) Data() any             { return ginH{"task": e.filter.Task} }
func (e *TaskDeletedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskDeletedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskDeletedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskDeletedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskAssignedEvent fires when a task's assignee changes
// (including null -> user and user -> null). Payload root is
// { task, previousAssignee } where previousAssignee is rendered
// as JSON null (Go `*string`) so receivers can distinguish
// "unassigned before" from "empty string before".
type TaskAssignedEvent struct {
	filter           TaskEventFilter
	previousAssignee *string
	at               time.Time
}

func NewTaskAssignedEvent(task TaskPayload, boardID string, previousAssignee *string, at time.Time) *TaskAssignedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskAssignedEvent{
		filter:           TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		previousAssignee: previousAssignee,
		at:               at,
	}
}

func (e *TaskAssignedEvent) EventType() string     { return "task.assigned" }
func (e *TaskAssignedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskAssignedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskAssignedEvent) Data() any {
	return ginH{
		"task":             e.filter.Task,
		"previousAssignee": e.previousAssignee,
	}
}
func (e *TaskAssignedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskAssignedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskAssignedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskAssignedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// TaskCommentedEvent fires when a comment row is inserted on a
// task (comments.go CreateComment). Payload root is { task,
// comment }.
type TaskCommentedEvent struct {
	filter  TaskEventFilter
	comment CommentPayload
	at      time.Time
}

func NewTaskCommentedEvent(task TaskPayload, boardID string, comment CommentPayload, at time.Time) *TaskCommentedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &TaskCommentedEvent{
		filter:  TaskEventFilter{Task: task, BoardID: boardID, ColumnID: task.ColumnID},
		comment: comment,
		at:      at,
	}
}

func (e *TaskCommentedEvent) EventType() string     { return "task.commented" }
func (e *TaskCommentedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *TaskCommentedEvent) OccurredAt() time.Time { return e.at }
func (e *TaskCommentedEvent) Data() any {
	return ginH{"task": e.filter.Task, "comment": e.comment}
}
func (e *TaskCommentedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *TaskCommentedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *TaskCommentedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *TaskCommentedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// BoardCreatedEvent fires when a new board row is inserted
// (boards_crud.go CreateBoard). Payload root is { board }.
type BoardCreatedEvent struct {
	board BoardPayload
	at    time.Time
}

func NewBoardCreatedEvent(board BoardPayload, at time.Time) *BoardCreatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &BoardCreatedEvent{board: board, at: at}
}

func (e *BoardCreatedEvent) EventType() string     { return "board.created" }
func (e *BoardCreatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *BoardCreatedEvent) OccurredAt() time.Time { return e.at }
func (e *BoardCreatedEvent) Data() any             { return ginH{"board": e.board} }
func (e *BoardCreatedEvent) FilterBoardID() string  { return "" }
func (e *BoardCreatedEvent) FilterColumnID() string { return "" }
func (e *BoardCreatedEvent) FilterPriority() string { return "" }
func (e *BoardCreatedEvent) FilterAssignee() string { return "" }

// BoardUpdatedEvent fires when a board row's metadata changes
// (boards_crud.go UpdateBoard). Payload root is { board,
// changes[] }.
type BoardUpdatedEvent struct {
	board   BoardPayload
	changes []ChangePayload
	at      time.Time
}

func NewBoardUpdatedEvent(board BoardPayload, changes []ChangePayload, at time.Time) *BoardUpdatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &BoardUpdatedEvent{board: board, changes: changes, at: at}
}

func (e *BoardUpdatedEvent) EventType() string     { return "board.updated" }
func (e *BoardUpdatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *BoardUpdatedEvent) OccurredAt() time.Time { return e.at }
func (e *BoardUpdatedEvent) Data() any {
	return ginH{"board": e.board, "changes": e.changes}
}
func (e *BoardUpdatedEvent) FilterBoardID() string  { return "" }
func (e *BoardUpdatedEvent) FilterColumnID() string { return "" }
func (e *BoardUpdatedEvent) FilterPriority() string { return "" }
func (e *BoardUpdatedEvent) FilterAssignee() string { return "" }

// ColumnCreatedEvent fires when a new column row is inserted
// (columns.go CreateColumn). Payload root is { column }.
type ColumnCreatedEvent struct {
	filter ColumnEventFilter
	column ColumnPayload
	at     time.Time
}

func NewColumnCreatedEvent(column ColumnPayload, at time.Time) *ColumnCreatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &ColumnCreatedEvent{
		filter: ColumnEventFilter{BoardID: column.BoardID},
		column: column,
		at:     at,
	}
}

func (e *ColumnCreatedEvent) EventType() string     { return "column.created" }
func (e *ColumnCreatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *ColumnCreatedEvent) OccurredAt() time.Time { return e.at }
func (e *ColumnCreatedEvent) Data() any             { return ginH{"column": e.column} }
func (e *ColumnCreatedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *ColumnCreatedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *ColumnCreatedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *ColumnCreatedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// ColumnUpdatedEvent fires when a column row's metadata changes
// (columns.go UpdateColumn). Payload root is { column,
// changes[] }.
type ColumnUpdatedEvent struct {
	filter  ColumnEventFilter
	column  ColumnPayload
	changes []ChangePayload
	at      time.Time
}

func NewColumnUpdatedEvent(column ColumnPayload, changes []ChangePayload, at time.Time) *ColumnUpdatedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &ColumnUpdatedEvent{
		filter:  ColumnEventFilter{BoardID: column.BoardID},
		column:  column,
		changes: changes,
		at:      at,
	}
}

func (e *ColumnUpdatedEvent) EventType() string     { return "column.updated" }
func (e *ColumnUpdatedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *ColumnUpdatedEvent) OccurredAt() time.Time { return e.at }
func (e *ColumnUpdatedEvent) Data() any {
	return ginH{"column": e.column, "changes": e.changes}
}
func (e *ColumnUpdatedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *ColumnUpdatedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *ColumnUpdatedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *ColumnUpdatedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// ColumnDeletedEvent fires when a column row is removed
// (columns.go DeleteColumn). Payload root is { column } and
// carries the pre-delete column snapshot.
type ColumnDeletedEvent struct {
	filter ColumnEventFilter
	column ColumnPayload
	at     time.Time
}

func NewColumnDeletedEvent(column ColumnPayload, at time.Time) *ColumnDeletedEvent {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return &ColumnDeletedEvent{
		filter: ColumnEventFilter{BoardID: column.BoardID},
		column: column,
		at:     at,
	}
}

func (e *ColumnDeletedEvent) EventType() string     { return "column.deleted" }
func (e *ColumnDeletedEvent) EnvelopeID() string    { return newEnvelopeID() }
func (e *ColumnDeletedEvent) OccurredAt() time.Time { return e.at }
func (e *ColumnDeletedEvent) Data() any             { return ginH{"column": e.column} }
func (e *ColumnDeletedEvent) FilterBoardID() string  { return e.filter.FilterBoardID() }
func (e *ColumnDeletedEvent) FilterColumnID() string { return e.filter.FilterColumnID() }
func (e *ColumnDeletedEvent) FilterPriority() string { return e.filter.FilterPriority() }
func (e *ColumnDeletedEvent) FilterAssignee() string { return e.filter.FilterAssignee() }

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

// ginH is a tiny alias for the gin.H style literal used in the
// Data() accessors. Declared locally so this file doesn't pull
// in the gin import — the dispatcher only marshals Data() to
// JSON, the map shape is the wire contract.
type ginH map[string]any

// newEnvelopeID returns a short opaque token used as the
// envelope.id. Random 12 bytes encoded as base64 (no padding)
// keeps the value distinguishable from the legacy "evt_<ulid>"
// format used by external receivers but still URL-safe and
// collision-resistant across a single process.
func newEnvelopeID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// rand.Read on linux is documented to never fail in
		// practice; fall back to the time-based token so the
		// publish path never panics inside an HTTP handler.
		return base64.RawURLEncoding.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
