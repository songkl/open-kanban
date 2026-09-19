package handlers

import "time"

type CreateTaskRequest struct {
	Title          string      `json:"title" validate:"required,max=500"`
	Description    *string     `json:"description" validate:"omitempty,max=5000"`
	Priority       string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee       *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta           interface{} `json:"meta"`
	ColumnID       string      `json:"columnId" validate:"required"`
	Position       int         `json:"position"`
	Published      bool        `json:"published"`
	// DueAt is the optional deadline the create-task modal
	// sends (T-1207 / s-1207, PM_REVIEW §3.12). Accepts RFC3339
	// via Go's time.Time json decoder; an empty / null value
	// means "no due date" and round-trips as NULL in the DB.
	DueAt    *time.Time `json:"dueAt"`
	AgentID  *string    `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string `json:"agentPrompt" validate:"omitempty,max=2000"`
	// AttachmentIDs is the list of attachment rows the modal
	// pre-uploaded (via POST /api/v1/upload) before submitting
	// the task create. The CreateTask handler re-links the rows
	// to the newly minted task by setting attachments.task_id
	// in a single UPDATE so the operator doesn't need to upload
	// again after the task exists. Tracked as T-1207 / s-1207.
	AttachmentIDs []string `json:"attachmentIds"`
}

type UpdateTaskRequest struct {
	Title          string      `json:"title" validate:"omitempty,required,max=500"`
	Description    *string     `json:"description" validate:"omitempty,max=5000"`
	Priority       string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee       *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta           interface{} `json:"meta"`
	ColumnID       string      `json:"columnId"`
	Position       *int        `json:"position"`
	Published      *bool       `json:"published"`
	// DueAt is the optional deadline the TaskModal saves (see
	// CreateTaskRequest for the rationale behind nullable).
	DueAt      *time.Time `json:"dueAt"`
	AgentID    *string    `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string   `json:"agentPrompt" validate:"omitempty,max=2000"`
}

type ArchiveTaskRequest struct {
	Archived *bool `json:"archived"`
}