package models

import "time"

// User represents a user in the system
type User struct {
	ID           string     `json:"id"`
	Nickname     string     `json:"nickname"`
	Avatar       string     `json:"avatar"`
	Type         string     `json:"type"` // HUMAN, AGENT
	Role         string     `json:"role"` // ADMIN, MEMBER, VIEWER
	Enabled      bool       `json:"enabled"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	LastActiveAt *time.Time `json:"lastActiveAt,omitempty"`
}

// Token represents an authentication token
type Token struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Key       string     `json:"key"`
	UserID    string     `json:"userId"`
	UserAgent string     `json:"userAgent,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

// Board represents a kanban board
type Board struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Deleted     bool      `json:"deleted"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Columns     []Column  `json:"columns,omitempty"`
	ColumnCount int       `json:"_count,omitempty"`
}

// Column represents a column in a board
type Column struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Status       *string      `json:"status,omitempty"`
	Position     int          `json:"position"`
	Color        string       `json:"color"`
	Description  string       `json:"description,omitempty"`
	BoardID      string       `json:"boardId"`
	OwnerAgentID *string      `json:"ownerAgentId,omitempty"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
	Tasks        []Task       `json:"tasks,omitempty"`
	AgentConfig  *ColumnAgent `json:"agentConfig,omitempty"`
}

// ColumnAgent represents agent configuration for a column
type ColumnAgent struct {
	ID         string    `json:"id"`
	ColumnID   string    `json:"columnId"`
	AgentTypes []string  `json:"agentTypes"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Task represents a task card
type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description *string    `json:"description,omitempty"`
	Priority    string     `json:"priority"` // low, medium, high
	Assignee    *string    `json:"assignee,omitempty"`
	Meta        *string    `json:"meta,omitempty"`
	ColumnID    string     `json:"columnId"`
	Position    int        `json:"position"`
	Published   bool       `json:"published"`
	Archived    bool       `json:"archived"`
	ArchivedAt  *time.Time `json:"archivedAt,omitempty"`
	AgentID     *string    `json:"agentId,omitempty"`
	AgentPrompt *string    `json:"agentPrompt,omitempty"`
	CreatedBy   string     `json:"createdBy"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	Comments    []Comment  `json:"comments,omitempty"`
	Subtasks    []Subtask  `json:"subtasks,omitempty"`
}

// Comment represents a comment on a task
type Comment struct {
	ID        string    `json:"id"`
	Content   string    `json:"content"`
	Author    string    `json:"author"`
	TaskID    string    `json:"taskId"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Subtask represents a subtask
type Subtask struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Completed bool      `json:"completed"`
	TaskID    string    `json:"taskId"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BoardPermission represents user permissions for a board
type BoardPermission struct {
	ID      string `json:"id"`
	UserID  string `json:"userId"`
	BoardID string `json:"boardId"`
	Access  string `json:"access"` // READ, WRITE, ADMIN
	Board   *Board `json:"board,omitempty"`
	User    *User  `json:"user,omitempty"`
}

// ColumnPermission represents user permissions for a column
type ColumnPermission struct {
	ID       string  `json:"id"`
	UserID   string  `json:"userId"`
	ColumnID string  `json:"columnId"`
	Access   string  `json:"access"` // READ, WRITE, ADMIN
	Column   *Column `json:"column,omitempty"`
	User     *User   `json:"user,omitempty"`
}

// Attachment represents a file attachment
type Attachment struct {
	ID          string    `json:"id"`
	Filename    string    `json:"filename"`
	StoragePath string    `json:"storagePath"`
	StorageType string    `json:"storageType"` // local, oss, s3
	MimeType    *string   `json:"mimeType,omitempty"`
	Size        int64     `json:"size"`
	UploaderID  *string   `json:"uploaderId,omitempty"`
	TaskID      *string   `json:"taskId,omitempty"`
	CommentID   *string   `json:"commentId,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
