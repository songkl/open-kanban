package models_test

import (
	"encoding/json"
	"testing"
	"time"

	"open-kanban/internal/models"
)

func TestTaskRunJSON(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	finished := now.Add(time.Minute)
	code := 0
	msg := "boom"

	run := models.TaskRun{
		TaskID:          "task-1",
		RunnerID:        "user-1",
		AgentID:         "cli-host-1234",
		BoardID:         "board-1",
		ColumnID:        "col-todo",
		Status:          models.RunStatusClaimed,
		ClaimedAt:       now,
		LastHeartbeatAt: now,
		ExpiresAt:       now.Add(2 * time.Minute),
		FinishedAt:      &finished,
		ExitCode:        &code,
		Error:           &msg,
	}

	data, err := json.Marshal(run)
	if err != nil {
		t.Fatalf("failed to marshal task run: %v", err)
	}

	var unmarshaled models.TaskRun
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("failed to unmarshal task run: %v", err)
	}

	if unmarshaled.TaskID != run.TaskID {
		t.Errorf("expected taskId %s, got %s", run.TaskID, unmarshaled.TaskID)
	}
	if unmarshaled.Status != models.RunStatusClaimed {
		t.Errorf("expected status claimed, got %s", unmarshaled.Status)
	}
	if unmarshaled.FinishedAt == nil || !unmarshaled.FinishedAt.Equal(finished) {
		t.Errorf("expected finishedAt %v, got %v", finished, unmarshaled.FinishedAt)
	}
	if unmarshaled.ExitCode == nil || *unmarshaled.ExitCode != 0 {
		t.Errorf("expected exitCode 0, got %v", unmarshaled.ExitCode)
	}
	if unmarshaled.Error == nil || *unmarshaled.Error != msg {
		t.Errorf("expected error %s, got %v", msg, unmarshaled.Error)
	}
}

// TestTaskRunJSON_OmitsUnsetOptionalFields locks down the
// omitempty behaviour of the three nullable columns: a live (not-yet
// finished) row serialised to JSON must NOT include finishedAt /
// exitCode / error keys, otherwise the CLI runner's status-poll
// endpoint would emit empty strings / zeros on every heartbeat.
func TestTaskRunJSON_OmitsUnsetOptionalFields(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	run := models.TaskRun{
		TaskID:          "task-1",
		RunnerID:        "user-1",
		AgentID:         "cli-host-1234",
		BoardID:         "board-1",
		ColumnID:        "col-todo",
		Status:          models.RunStatusClaimed,
		ClaimedAt:       now,
		LastHeartbeatAt: now,
		ExpiresAt:       now.Add(2 * time.Minute),
	}

	data, err := json.Marshal(run)
	if err != nil {
		t.Fatalf("failed to marshal task run: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("failed to unmarshal task run into map: %v", err)
	}

	for _, omitted := range []string{"finishedAt", "exitCode", "error"} {
		if _, present := raw[omitted]; present {
			t.Errorf("expected %q to be omitted from JSON for live row, got %s", omitted, string(data))
		}
	}
}

func TestRunStatusIsLive(t *testing.T) {
	cases := []struct {
		status models.RunStatus
		live   bool
	}{
		{models.RunStatusClaimed, true},
		{models.RunStatusRunning, true},
		{models.RunStatusCompleted, false},
		{models.RunStatusFailed, false},
		{models.RunStatusReleased, false},
		{models.RunStatus("garbage"), false},
	}
	for _, c := range cases {
		if got := c.status.IsLive(); got != c.live {
			t.Errorf("RunStatus(%q).IsLive() = %v, want %v", c.status, got, c.live)
		}
	}
}

func TestRunStatusValid(t *testing.T) {
	for s := range models.ValidRunStatuses {
		if !s.IsLive() && s != models.RunStatusCompleted && s != models.RunStatusFailed && s != models.RunStatusReleased {
			t.Errorf("unexpected status in ValidRunStatuses: %q", s)
		}
	}
	// Spot-check that the canonical five are all present.
	for _, want := range []models.RunStatus{
		models.RunStatusClaimed, models.RunStatusRunning,
		models.RunStatusCompleted, models.RunStatusFailed,
		models.RunStatusReleased,
	} {
		if _, ok := models.ValidRunStatuses[want]; !ok {
			t.Errorf("expected %q in ValidRunStatuses", want)
		}
	}
}

func TestToTaskRun(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	expires := now.Add(2 * time.Minute)

	tr := models.ToTaskRun(
		"task-1", "user-1", "cli-host", "board-1", "col-todo",
		models.RunStatusClaimed, now, now, expires,
	)

	if tr.TaskID != "task-1" || tr.RunnerID != "user-1" || tr.AgentID != "cli-host" {
		t.Errorf("identity fields not copied through ToTaskRun: %+v", tr)
	}
	if tr.BoardID != "board-1" || tr.ColumnID != "col-todo" {
		t.Errorf("board/column not copied through ToTaskRun: %+v", tr)
	}
	if tr.Status != models.RunStatusClaimed {
		t.Errorf("expected status claimed, got %s", tr.Status)
	}
	if !tr.ClaimedAt.Equal(now) || !tr.LastHeartbeatAt.Equal(now) || !tr.ExpiresAt.Equal(expires) {
		t.Errorf("timestamps not copied through ToTaskRun: %+v", tr)
	}
	// Optional fields should stay nil — the constructor never sets them.
	if tr.FinishedAt != nil || tr.ExitCode != nil || tr.Error != nil {
		t.Errorf("ToTaskRun should not populate optional fields, got %+v", tr)
	}
}
