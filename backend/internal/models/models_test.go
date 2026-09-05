package models_test

import (
	"encoding/json"
	"testing"
	"time"

	"open-kanban/internal/models"
)

func TestUserJSON(t *testing.T) {
	now := time.Now()
	user := models.User{
		ID:        "user-1",
		Username:  "testuser",
		Nickname:  "Test User",
		Avatar:    "avatar.png",
		Type:      "HUMAN",
		Role:      "ADMIN",
		Enabled:   true,
		CreatedAt: now,
		UpdatedAt: now,
	}

	data, err := json.Marshal(user)
	if err != nil {
		t.Fatalf("failed to marshal user: %v", err)
	}

	var unmarshaled models.User
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal user: %v", err)
	}

	if unmarshaled.ID != user.ID {
		t.Errorf("expected ID %s, got %s", user.ID, unmarshaled.ID)
	}
	if unmarshaled.Username != user.Username {
		t.Errorf("expected username %s, got %s", user.Username, unmarshaled.Username)
	}
}

func TestTaskJSON(t *testing.T) {
	now := time.Now()
	desc := "test description"
	task := models.Task{
		ID:          "task-1",
		Title:       "Test Task",
		Description: &desc,
		Priority:    "high",
		ColumnID:    "col-1",
		Position:    1,
		Published:   true,
		Archived:    false,
		CreatedBy:   "user-1",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	data, err := json.Marshal(task)
	if err != nil {
		t.Fatalf("failed to marshal task: %v", err)
	}

	var unmarshaled models.Task
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal task: %v", err)
	}

	if unmarshaled.ID != task.ID {
		t.Errorf("expected ID %s, got %s", task.ID, unmarshaled.ID)
	}
	if unmarshaled.Priority != task.Priority {
		t.Errorf("expected priority %s, got %s", task.Priority, unmarshaled.Priority)
	}
	if *unmarshaled.Description != desc {
		t.Errorf("expected description %s, got %s", desc, *unmarshaled.Description)
	}
}

func TestBoardJSON(t *testing.T) {
	now := time.Now()
	board := models.Board{
		ID:          "board-1",
		Name:        "Test Board",
		Description: "A test board",
		Deleted:     false,
		CreatedAt:   now,
		UpdatedAt:   now,
		ColumnCount: 5,
	}

	data, err := json.Marshal(board)
	if err != nil {
		t.Fatalf("failed to marshal board: %v", err)
	}

	var unmarshaled models.Board
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal board: %v", err)
	}

	if unmarshaled.ID != board.ID {
		t.Errorf("expected ID %s, got %s", board.ID, unmarshaled.ID)
	}
	if unmarshaled.ColumnCount != board.ColumnCount {
		t.Errorf("expected ColumnCount %d, got %d", board.ColumnCount, unmarshaled.ColumnCount)
	}
}

func TestColumnJSON(t *testing.T) {
	now := time.Now()
	status := "todo"
	col := models.Column{
		ID:          "col-1",
		Name:        "To Do",
		Status:      &status,
		Position:    0,
		Color:       "#ef4444",
		Description: "Tasks to do",
		BoardID:     "board-1",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	data, err := json.Marshal(col)
	if err != nil {
		t.Fatalf("failed to marshal column: %v", err)
	}

	var unmarshaled models.Column
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal column: %v", err)
	}

	if unmarshaled.ID != col.ID {
		t.Errorf("expected ID %s, got %s", col.ID, unmarshaled.ID)
	}
	if *unmarshaled.Status != status {
		t.Errorf("expected status %s, got %s", status, *unmarshaled.Status)
	}
}

func TestCommentJSON(t *testing.T) {
	now := time.Now()
	comment := models.Comment{
		ID:        "comment-1",
		Content:   "Test comment",
		Author:    "user-1",
		TaskID:    "task-1",
		CreatedAt: now,
		UpdatedAt: now,
	}

	data, err := json.Marshal(comment)
	if err != nil {
		t.Fatalf("failed to marshal comment: %v", err)
	}

	var unmarshaled models.Comment
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal comment: %v", err)
	}

	if unmarshaled.ID != comment.ID {
		t.Errorf("expected ID %s, got %s", comment.ID, unmarshaled.ID)
	}
	if unmarshaled.Content != comment.Content {
		t.Errorf("expected content %s, got %s", comment.Content, unmarshaled.Content)
	}
}

func TestSubtaskJSON(t *testing.T) {
	now := time.Now()
	subtask := models.Subtask{
		ID:        "subtask-1",
		Title:     "Test subtask",
		Completed: true,
		TaskID:    "task-1",
		CreatedAt: now,
		UpdatedAt: now,
	}

	data, err := json.Marshal(subtask)
	if err != nil {
		t.Fatalf("failed to marshal subtask: %v", err)
	}

	var unmarshaled models.Subtask
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal subtask: %v", err)
	}

	if unmarshaled.ID != subtask.ID {
		t.Errorf("expected ID %s, got %s", subtask.ID, unmarshaled.ID)
	}
	if unmarshaled.Completed != subtask.Completed {
		t.Errorf("expected completed %v, got %v", subtask.Completed, unmarshaled.Completed)
	}
}

func TestTokenJSON(t *testing.T) {
	now := time.Now()
	token := models.Token{
		ID:        "token-1",
		Name:      "Test Token",
		Key:       "key-123",
		UserID:    "user-1",
		UserAgent: "test-agent",
		CreatedAt: now,
		UpdatedAt: now,
	}

	data, err := json.Marshal(token)
	if err != nil {
		t.Fatalf("failed to marshal token: %v", err)
	}

	var unmarshaled models.Token
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal token: %v", err)
	}

	if unmarshaled.ID != token.ID {
		t.Errorf("expected ID %s, got %s", token.ID, unmarshaled.ID)
	}
	if unmarshaled.Key != token.Key {
		t.Errorf("expected key %s, got %s", token.Key, unmarshaled.Key)
	}
}

func TestBoardPermissionJSON(t *testing.T) {
	perm := models.BoardPermission{
		ID:      "perm-1",
		UserID:  "user-1",
		BoardID: "board-1",
		Access:  "WRITE",
	}

	data, err := json.Marshal(perm)
	if err != nil {
		t.Fatalf("failed to marshal permission: %v", err)
	}

	var unmarshaled models.BoardPermission
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal permission: %v", err)
	}

	if unmarshaled.Access != perm.Access {
		t.Errorf("expected access %s, got %s", perm.Access, unmarshaled.Access)
	}
}

func TestColumnPermissionJSON(t *testing.T) {
	perm := models.ColumnPermission{
		ID:       "cperm-1",
		UserID:   "user-1",
		ColumnID: "col-1",
		Access:   "READ",
	}

	data, err := json.Marshal(perm)
	if err != nil {
		t.Fatalf("failed to marshal permission: %v", err)
	}

	var unmarshaled models.ColumnPermission
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal permission: %v", err)
	}

	if unmarshaled.Access != perm.Access {
		t.Errorf("expected access %s, got %s", perm.Access, unmarshaled.Access)
	}
}

func TestAttachmentJSON(t *testing.T) {
	now := time.Now()
	mime := "image/png"
	attach := models.Attachment{
		ID:          "attach-1",
		Filename:    "test.png",
		StoragePath: "/uploads/test.png",
		StorageType: "local",
		MimeType:    &mime,
		Size:        1024,
		TaskID:      strPtr("task-1"),
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	data, err := json.Marshal(attach)
	if err != nil {
		t.Fatalf("failed to marshal attachment: %v", err)
	}

	var unmarshaled models.Attachment
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal attachment: %v", err)
	}

	if unmarshaled.Filename != attach.Filename {
		t.Errorf("expected filename %s, got %s", attach.Filename, unmarshaled.Filename)
	}
	if unmarshaled.Size != attach.Size {
		t.Errorf("expected size %d, got %d", attach.Size, unmarshaled.Size)
	}
}

func TestColumnAgentJSON(t *testing.T) {
	now := time.Now()
	agent := models.ColumnAgent{
		ID:         "cagent-1",
		ColumnID:   "col-1",
		AgentTypes: []string{"coder", "reviewer"},
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	data, err := json.Marshal(agent)
	if err != nil {
		t.Fatalf("failed to marshal column agent: %v", err)
	}

	var unmarshaled models.ColumnAgent
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal column agent: %v", err)
	}

	if len(unmarshaled.AgentTypes) != len(agent.AgentTypes) {
		t.Errorf("expected %d agent types, got %d", len(agent.AgentTypes), len(unmarshaled.AgentTypes))
	}
}

func strPtr(s string) *string {
	return &s
}

func TestOAuthClientJSON(t *testing.T) {
	now := time.Now()
	client := models.OAuthClient{
		ID:                      "client-row-1",
		ClientID:                "open-kanban-mcp",
		ClientSecretHash:        nil,
		Name:                    "Open Kanban MCP",
		RedirectURIs:            []string{"http://127.0.0.1:9999/callback"},
		GrantTypes:              []string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		TokenEndpointAuthMethod: "none",
		Scopes:                  []string{"kanban:read", "tasks:write"},
		IsFirstParty:            true,
		CreatedAt:               now,
		UpdatedAt:               now,
	}

	data, err := json.Marshal(client)
	if err != nil {
		t.Fatalf("failed to marshal oauth client: %v", err)
	}

	var unmarshaled models.OAuthClient
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal oauth client: %v", err)
	}
	if unmarshaled.ClientID != client.ClientID {
		t.Errorf("expected client id %s, got %s", client.ClientID, unmarshaled.ClientID)
	}
	if len(unmarshaled.GrantTypes) != 2 {
		t.Errorf("expected 2 grant types, got %d", len(unmarshaled.GrantTypes))
	}
	if unmarshaled.ClientSecretHash != nil {
		t.Errorf("expected client secret hash to be hidden (json:\"-\")")
	}
}

func TestOAuthDeviceCodeJSON(t *testing.T) {
	now := time.Now()
	uid := "user-1"
	device := models.OAuthDeviceCode{
		ID:              "dc-1",
		DeviceCodeHash:  "should-not-leak",
		UserCodeHash:    "should-not-leak",
		UserCodeDisplay: "ABCD-1234",
		ClientID:        "open-kanban-mcp",
		Scope:           "kanban:read tasks:write",
		ExpiresAt:       now.Add(10 * time.Minute),
		IntervalSeconds: 5,
		Status:          "pending",
		UserID:          &uid,
		VerificationURI: "http://localhost:8080/oauth/device",
		CreatedAt:       now,
	}

	data, err := json.Marshal(device)
	if err != nil {
		t.Fatalf("failed to marshal oauth device code: %v", err)
	}

	if got := string(data); got == "" {
		t.Fatal("empty marshal output")
	}

	var unmarshaled models.OAuthDeviceCode
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal oauth device code: %v", err)
	}
	if unmarshaled.UserCodeDisplay != "ABCD-1234" {
		t.Errorf("expected user code display ABCD-1234, got %s", unmarshaled.UserCodeDisplay)
	}
	if unmarshaled.DeviceCodeHash != "" {
		t.Errorf("expected device_code_hash to be hidden, got %q", unmarshaled.DeviceCodeHash)
	}
	if unmarshaled.UserCodeHash != "" {
		t.Errorf("expected user_code_hash to be hidden, got %q", unmarshaled.UserCodeHash)
	}
}

func TestOAuthTokenResponseJSON(t *testing.T) {
	resp := models.OAuthTokenResponse{
		AccessToken:  "header.payload.sig",
		TokenType:    "Bearer",
		ExpiresIn:    3600,
		RefreshToken: "rt-123",
		Scope:        "kanban:read",
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal oauth token response: %v", err)
	}
	var unmarshaled models.OAuthTokenResponse
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal oauth token response: %v", err)
	}
	if unmarshaled.AccessToken != resp.AccessToken {
		t.Errorf("expected access_token %s, got %s", resp.AccessToken, unmarshaled.AccessToken)
	}
	if unmarshaled.TokenType != "Bearer" {
		t.Errorf("expected token_type Bearer, got %s", unmarshaled.TokenType)
	}
	if unmarshaled.ExpiresIn != 3600 {
		t.Errorf("expected expires_in 3600, got %d", unmarshaled.ExpiresIn)
	}
}

func TestOAuthErrorResponseJSON(t *testing.T) {
	resp := models.OAuthErrorResponse{
		Error:            "invalid_request",
		ErrorDescription: "client_id is required",
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal oauth error response: %v", err)
	}
	if got := string(data); got == "" {
		t.Fatal("empty marshal output")
	}
	var unmarshaled models.OAuthErrorResponse
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal oauth error response: %v", err)
	}
	if unmarshaled.Error != "invalid_request" {
		t.Errorf("expected error invalid_request, got %s", unmarshaled.Error)
	}
}

func TestDeviceAuthorizationResponseJSON(t *testing.T) {
	resp := models.DeviceAuthorizationResponse{
		DeviceCode:              "device-secret",
		UserCode:                "WXYZ-9876",
		VerificationURI:         "http://localhost:8080/oauth/device",
		VerificationURIComplete: "http://localhost:8080/oauth/device?user_code=WXYZ-9876",
		ExpiresIn:               600,
		Interval:                5,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal device authorization response: %v", err)
	}
	var unmarshaled models.DeviceAuthorizationResponse
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal device authorization response: %v", err)
	}
	if unmarshaled.UserCode != "WXYZ-9876" {
		t.Errorf("expected user_code WXYZ-9876, got %s", unmarshaled.UserCode)
	}
	if unmarshaled.Interval != 5 {
		t.Errorf("expected interval 5, got %d", unmarshaled.Interval)
	}
}
