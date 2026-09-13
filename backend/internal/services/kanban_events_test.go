package services_test

import (
	"encoding/json"
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestKanbanEvents_EventTypeAndFilters is the table-driven
// smoke test for every concrete Event implementation added in
// s-1153. The table enumerates each call site, the expected
// event.type string the §3 catalogue promises, and the
// dispatcher-relevant filter dimensions the test checks. A
// regression that drops an event type or breaks the filter
// wiring fails this test loudly.
func TestKanbanEvents_EventTypeAndFilters(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	task := services.TaskPayload{
		ID:         "T-1",
		Title:      "Test task",
		ColumnID:   "col-1",
		ColumnName: "Todo",
		Priority:   "high",
		Assignee:   "alice",
	}
	prev := "bob"

	cases := []struct {
		name         string
		event        services.Event
		wantType     string
		wantBoardID  string
		wantColumnID string
		wantPriority string
		wantAssignee string
	}{
		{
			name:         "task.created",
			event:        services.NewTaskCreatedEvent(task, "board-1", now),
			wantType:     "task.created",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "task.updated",
			event:        services.NewTaskUpdatedEvent(task, "board-1", []services.ChangePayload{{Field: "title", From: "Old", To: "New"}}, now),
			wantType:     "task.updated",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "task.moved",
			event:        services.NewTaskMovedEvent(task, "board-1", "col-0", now),
			wantType:     "task.moved",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "task.completed",
			event:        services.NewTaskCompletedEvent(task, "board-1", now),
			wantType:     "task.completed",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "task.deleted",
			event:        services.NewTaskDeletedEvent(task, "board-1", now),
			wantType:     "task.deleted",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "task.assigned",
			event:        services.NewTaskAssignedEvent(task, "board-1", &prev, now),
			wantType:     "task.assigned",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name: "task.commented",
			event: services.NewTaskCommentedEvent(task, "board-1", services.CommentPayload{
				ID:        "c-1",
				Content:   "Looks good",
				Author:    "alice",
				TaskID:    "T-1",
				CreatedAt: now,
			}, now),
			wantType:     "task.commented",
			wantBoardID:  "board-1",
			wantColumnID: "col-1",
			wantPriority: "high",
			wantAssignee: "alice",
		},
		{
			name:         "board.created",
			event:        services.NewBoardCreatedEvent(services.BoardPayload{ID: "board-1", Name: "Demo"}, now),
			wantType:     "board.created",
			wantBoardID:  "",
			wantColumnID: "",
			wantPriority: "",
			wantAssignee: "",
		},
		{
			name:         "board.updated",
			event:        services.NewBoardUpdatedEvent(services.BoardPayload{ID: "board-1", Name: "Demo"}, nil, now),
			wantType:     "board.updated",
			wantBoardID:  "",
			wantColumnID: "",
			wantPriority: "",
			wantAssignee: "",
		},
		{
			name: "column.created",
			event: services.NewColumnCreatedEvent(services.ColumnPayload{
				ID: "col-1", Name: "Todo", BoardID: "board-1", Position: 0,
			}, now),
			wantType:     "column.created",
			wantBoardID:  "board-1",
			wantColumnID: "",
			wantPriority: "",
			wantAssignee: "",
		},
		{
			name: "column.updated",
			event: services.NewColumnUpdatedEvent(services.ColumnPayload{
				ID: "col-1", Name: "Todo", BoardID: "board-1", Position: 0,
			}, nil, now),
			wantType:     "column.updated",
			wantBoardID:  "board-1",
			wantColumnID: "",
			wantPriority: "",
			wantAssignee: "",
		},
		{
			name: "column.deleted",
			event: services.NewColumnDeletedEvent(services.ColumnPayload{
				ID: "col-1", Name: "Todo", BoardID: "board-1", Position: 0,
			}, now),
			wantType:     "column.deleted",
			wantBoardID:  "board-1",
			wantColumnID: "",
			wantPriority: "",
			wantAssignee: "",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.event.EventType(); got != tc.wantType {
				t.Errorf("EventType: want %q, got %q", tc.wantType, got)
			}
			if id := tc.event.EnvelopeID(); id == "" {
				t.Errorf("EnvelopeID must be non-empty")
			}
			f, ok := tc.event.(services.Filterable)
			if !ok {
				t.Fatalf("event must implement Filterable")
			}
			if got := f.FilterBoardID(); got != tc.wantBoardID {
				t.Errorf("FilterBoardID: want %q, got %q", tc.wantBoardID, got)
			}
			if got := f.FilterColumnID(); got != tc.wantColumnID {
				t.Errorf("FilterColumnID: want %q, got %q", tc.wantColumnID, got)
			}
			if got := f.FilterPriority(); got != tc.wantPriority {
				t.Errorf("FilterPriority: want %q, got %q", tc.wantPriority, got)
			}
			if got := f.FilterAssignee(); got != tc.wantAssignee {
				t.Errorf("FilterAssignee: want %q, got %q", tc.wantAssignee, got)
			}
			if tc.event.OccurredAt().IsZero() {
				t.Errorf("OccurredAt must be non-zero")
			}
			if tc.event.Data() == nil {
				t.Errorf("Data must be non-nil")
			}
		})
	}
}

// TestKanbanEvents_PayloadShape asserts the JSON wire shape of
// every event's data accessor matches the catalogue schema
// (§3 / webhook_events.go). The catalogue is the contract
// with external receivers, so a renamed field or a missing
// required key surfaces here as a regression.
func TestKanbanEvents_PayloadShape(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	task := services.TaskPayload{
		ID:         "T-1",
		Title:      "Test task",
		ColumnID:   "col-1",
		ColumnName: "Todo",
		Priority:   "high",
		Assignee:   "alice",
	}
	prev := "bob"

	cases := []struct {
		name              string
		event             services.Event
		wantType          string
		wantDataKeys      []string
		wantNestedTaskKey bool
	}{
		{
			name:              "task.created carries task",
			event:             services.NewTaskCreatedEvent(task, "board-1", now),
			wantType:          "task.created",
			wantDataKeys:      []string{"task"},
			wantNestedTaskKey: true,
		},
		{
			name:              "task.updated carries task + changes",
			event:             services.NewTaskUpdatedEvent(task, "board-1", []services.ChangePayload{{Field: "title", From: "Old", To: "New"}}, now),
			wantType:          "task.updated",
			wantDataKeys:      []string{"task", "changes"},
			wantNestedTaskKey: true,
		},
		{
			name:              "task.moved carries task + fromColumnId + toColumnId",
			event:             services.NewTaskMovedEvent(task, "board-1", "col-0", now),
			wantType:          "task.moved",
			wantDataKeys:      []string{"task", "fromColumnId", "toColumnId"},
			wantNestedTaskKey: true,
		},
		{
			name:              "task.completed carries task",
			event:             services.NewTaskCompletedEvent(task, "board-1", now),
			wantType:          "task.completed",
			wantDataKeys:      []string{"task"},
			wantNestedTaskKey: true,
		},
		{
			name:              "task.deleted carries task",
			event:             services.NewTaskDeletedEvent(task, "board-1", now),
			wantType:          "task.deleted",
			wantDataKeys:      []string{"task"},
			wantNestedTaskKey: true,
		},
		{
			name:              "task.assigned carries task + previousAssignee",
			event:             services.NewTaskAssignedEvent(task, "board-1", &prev, now),
			wantType:          "task.assigned",
			wantDataKeys:      []string{"task", "previousAssignee"},
			wantNestedTaskKey: true,
		},
		{
			name: "task.commented carries task + comment",
			event: services.NewTaskCommentedEvent(task, "board-1", services.CommentPayload{
				ID: "c-1", Content: "hi", Author: "alice", TaskID: "T-1", CreatedAt: now,
			}, now),
			wantType:          "task.commented",
			wantDataKeys:      []string{"task", "comment"},
			wantNestedTaskKey: true,
		},
		{
			name:              "board.created carries board",
			event:             services.NewBoardCreatedEvent(services.BoardPayload{ID: "board-1", Name: "Demo"}, now),
			wantType:          "board.created",
			wantDataKeys:      []string{"board"},
			wantNestedTaskKey: false,
		},
		{
			name:              "board.updated carries board + changes",
			event:             services.NewBoardUpdatedEvent(services.BoardPayload{ID: "board-1", Name: "Demo"}, nil, now),
			wantType:          "board.updated",
			wantDataKeys:      []string{"board", "changes"},
			wantNestedTaskKey: false,
		},
		{
			name:              "column.created carries column",
			event:             services.NewColumnCreatedEvent(services.ColumnPayload{ID: "col-1", Name: "Todo", BoardID: "board-1"}, now),
			wantType:          "column.created",
			wantDataKeys:      []string{"column"},
			wantNestedTaskKey: false,
		},
		{
			name:              "column.updated carries column + changes",
			event:             services.NewColumnUpdatedEvent(services.ColumnPayload{ID: "col-1", Name: "Todo", BoardID: "board-1"}, nil, now),
			wantType:          "column.updated",
			wantDataKeys:      []string{"column", "changes"},
			wantNestedTaskKey: false,
		},
		{
			name:              "column.deleted carries column",
			event:             services.NewColumnDeletedEvent(services.ColumnPayload{ID: "col-1", Name: "Todo", BoardID: "board-1"}, now),
			wantType:          "column.deleted",
			wantDataKeys:      []string{"column"},
			wantNestedTaskKey: false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			data := tc.event.Data()
			raw, err := json.Marshal(data)
			if err != nil {
				t.Fatalf("marshal data: %v", err)
			}
			var generic map[string]any
			if err := json.Unmarshal(raw, &generic); err != nil {
				t.Fatalf("unmarshal data: %v", err)
			}
			for _, key := range tc.wantDataKeys {
				if _, ok := generic[key]; !ok {
					t.Errorf("data missing key %q: %s", key, string(raw))
				}
			}
			if tc.wantNestedTaskKey {
				taskObj, ok := generic["task"].(map[string]any)
				if !ok {
					t.Fatalf("data.task must be an object: %s", string(raw))
				}
				for _, key := range []string{"id", "title", "columnId", "priority"} {
					if _, ok := taskObj[key]; !ok {
						t.Errorf("data.task missing key %q: %s", key, string(raw))
					}
				}
			}
		})
	}
}

// TestKanbanEvents_TaskAssignedPreviousNil covers the
// "previousAssignee: null → user" branch specifically because
// the JSON shape (nil pointer → JSON null) is easy to break
// by accident — encoding/json serialises a nil *string as
// `null`, not as the empty string.
func TestKanbanEvents_TaskAssignedPreviousNil(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	task := services.TaskPayload{ID: "T-1", Title: "t", ColumnID: "col-1", Priority: "high", Assignee: "alice"}
	ev := services.NewTaskAssignedEvent(task, "board-1", nil, now)
	raw, err := json.Marshal(ev.Data())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["previousAssignee"] != nil {
		t.Errorf("previousAssignee should be JSON null, got %v", got["previousAssignee"])
	}
}

// TestKanbanEvents_TaskMovedEnvelopesToColumn verifies that
// the task.moved envelope renders fromColumnId and toColumnId
// at the top of the data object so receivers don't need to
// reach into a nested object. The catalogue schema
// (webhook_events.go) promises these as siblings of "task".
func TestKanbanEvents_TaskMovedEnvelopesToColumn(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	task := services.TaskPayload{ID: "T-1", Title: "t", ColumnID: "col-2", Priority: "high"}
	ev := services.NewTaskMovedEvent(task, "board-1", "col-1", now)
	raw, _ := json.Marshal(ev.Data())
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["fromColumnId"] != "col-1" {
		t.Errorf("fromColumnId: want col-1, got %v", got["fromColumnId"])
	}
	if got["toColumnId"] != "col-2" {
		t.Errorf("toColumnId: want col-2, got %v", got["toColumnId"])
	}
}

// TestKanbanEvents_EnvelopesAreUnique stamps out a small
// batch of envelope ids from distinct Event instances and
// asserts none collide. The generator is meant to be
// collision-resistant across a process lifetime, not
// cryptographically unique; the test catches accidental
// regressions to a constant value (e.g. always returning "").
func TestKanbanEvents_EnvelopesAreUnique(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	task := services.TaskPayload{ID: "T-1", Title: "t", ColumnID: "col-1", Priority: "high"}
	seen := make(map[string]struct{}, 1024)
	for i := 0; i < 1024; i++ {
		ev := services.NewTaskCreatedEvent(task, "board-1", now)
		id := ev.EnvelopeID()
		if id == "" {
			t.Fatalf("envelope id must be non-empty")
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("envelope id collision: %q", id)
		}
		seen[id] = struct{}{}
	}
}
