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
