package handlers

type CreateTaskRequest struct {
	Title       string      `json:"title" validate:"required,max=500"`
	Description *string     `json:"description" validate:"omitempty,max=5000"`
	Priority    string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee    *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId" validate:"required"`
	Position    int         `json:"position"`
	Published   bool        `json:"published"`
	AgentID     *string     `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string     `json:"agentPrompt" validate:"omitempty,max=2000"`
}

type UpdateTaskRequest struct {
	Title       string      `json:"title" validate:"omitempty,required,max=500"`
	Description *string     `json:"description" validate:"omitempty,max=5000"`
	Priority    string      `json:"priority" validate:"omitempty,oneof=low medium high"`
	Assignee    *string     `json:"assignee" validate:"omitempty,max=100"`
	Meta        interface{} `json:"meta"`
	ColumnID    string      `json:"columnId"`
	Position    *int        `json:"position"`
	Published   *bool       `json:"published"`
	AgentID     *string     `json:"agentId" validate:"omitempty,uuid"`
	AgentPrompt *string     `json:"agentPrompt" validate:"omitempty,max=2000"`
}

type ArchiveTaskRequest struct {
	Archived *bool `json:"archived"`
}
