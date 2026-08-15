package models

import "time"

// User represents a user in the system
type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"` // 登录名
	Nickname     string     `json:"nickname"` // 昵称
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
	ID                string     `json:"id"`
	Title             string     `json:"title"`
	Description       *string    `json:"description,omitempty"`
	Priority          string     `json:"priority"` // low, medium, high
	Assignee          *string    `json:"assignee,omitempty"`
	Meta              *string    `json:"meta,omitempty"`
	ColumnID          string     `json:"columnId"`
	Position          int        `json:"position"`
	Published         bool       `json:"published"`
	Archived          bool       `json:"archived"`
	ArchivedAt        *time.Time `json:"archivedAt,omitempty"`
	AgentID           *string    `json:"agentId,omitempty"`
	AgentPrompt       *string    `json:"agentPrompt,omitempty"`
	CreatedBy         string     `json:"createdBy"`
	CreatedByUsername string     `json:"createdByUsername,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
	Comments          []Comment  `json:"comments,omitempty"`
	Subtasks          []Subtask  `json:"subtasks,omitempty"`
	CommentCount      *int       `json:"commentCount,omitempty"`
	SubtaskCount      *int       `json:"subtaskCount,omitempty"`
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

// OAuthClient represents a registered OAuth 2.1 client (RFC 7591).
type OAuthClient struct {
	ID                       string    `json:"id"`
	ClientID                 string    `json:"clientId"`
	ClientSecretHash         *string   `json:"-"`
	Name                     string    `json:"name"`
	RedirectURIs             []string  `json:"redirectUris"`
	GrantTypes               []string  `json:"grantTypes"`
	TokenEndpointAuthMethod  string    `json:"tokenEndpointAuthMethod"`
	Scopes                   []string  `json:"scopes"`
	IsFirstParty             bool      `json:"isFirstParty"`
	CreatedByUserID          *string   `json:"createdByUserId,omitempty"`
	CreatedAt                time.Time `json:"createdAt"`
	UpdatedAt                time.Time `json:"updatedAt"`
}

// OAuthClientRegistrationResponse is what RFC 7591 returns to the client.
type OAuthClientRegistrationResponse struct {
	ClientID                string   `json:"client_id"`
	ClientSecret            string   `json:"client_secret,omitempty"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	ClientSecretExpiresAt   int64    `json:"client_secret_expires_at,omitempty"`
	RedirectURIs            []string `json:"redirect_uris,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
	ClientName              string   `json:"client_name,omitempty"`
}

// OAuthAuthorizationCode represents a short-lived code (RFC 6749 §4.1.2).
type OAuthAuthorizationCode struct {
	Code                string    `json:"code"`
	ClientID            string    `json:"clientId"`
	UserID              string    `json:"userId"`
	RedirectURI         string    `json:"redirectUri"`
	Scope               string    `json:"scope"`
	CodeChallenge       *string   `json:"codeChallenge,omitempty"`
	CodeChallengeMethod *string   `json:"codeChallengeMethod,omitempty"`
	ExpiresAt           time.Time `json:"expiresAt"`
	UsedAt              *time.Time `json:"usedAt,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
}

// OAuthDeviceCode represents a device authorization grant (RFC 8628).
type OAuthDeviceCode struct {
	ID               string     `json:"id"`
	DeviceCodeHash   string     `json:"-"`
	UserCodeHash     string     `json:"-"`
	UserCodeDisplay  string     `json:"userCode"`
	ClientID         string     `json:"clientId"`
	Scope            string     `json:"scope"`
	ExpiresAt        time.Time  `json:"expiresAt"`
	IntervalSeconds  int        `json:"interval"`
	LastPollAt       *time.Time `json:"lastPollAt,omitempty"`
	Status           string     `json:"status"` // pending|approved|denied|expired
	UserID           *string    `json:"userId,omitempty"`
	VerificationURI  string     `json:"verificationUri"`
	CreatedAt        time.Time  `json:"createdAt"`
}

// OAuthRefreshToken represents a stored refresh token (hashed at rest).
type OAuthRefreshToken struct {
	ID           string     `json:"id"`
	TokenHash    string     `json:"-"`
	ClientID     string     `json:"clientId"`
	UserID       string     `json:"userId"`
	Scope        string     `json:"scope"`
	ExpiresAt    time.Time  `json:"expiresAt"`
	RevokedAt    *time.Time `json:"revokedAt,omitempty"`
	ReplacedByID *string    `json:"replacedById,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// OAuthConsent records that a user has authorized a client for a scope set.
type OAuthConsent struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	ClientID  string    `json:"clientId"`
	Scope     string    `json:"scope"`
	GrantedAt time.Time `json:"grantedAt"`
}

// OAuthTokenResponse is the standard response from /oauth/token.
type OAuthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

// OAuthErrorResponse is the standard error response from OAuth endpoints.
type OAuthErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
	ErrorURI         string `json:"error_uri,omitempty"`
}

// DeviceAuthorizationResponse is what RFC 8628 §3.2 returns.
type DeviceAuthorizationResponse struct {
	DeviceCode               string `json:"device_code"`
	UserCode                 string `json:"user_code"`
	VerificationURI          string `json:"verification_uri"`
	VerificationURIComplete  string `json:"verification_uri_complete,omitempty"`
	ExpiresIn                int64  `json:"expires_in"`
	Interval                 int    `json:"interval"`
}
