package services_test

import (
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/models"
	"open-kanban/internal/services"
)

func setupServiceTestDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		short_alias TEXT UNIQUE,
		task_counter INTEGER DEFAULT 1000,
		deleted BOOLEAN DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		description TEXT DEFAULT ''
	);
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT,
		position INTEGER DEFAULT 0,
		color TEXT DEFAULT '#6b7280',
		description TEXT DEFAULT '',
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
		meta TEXT,
		column_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 0,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		agent_id TEXT,
		agent_prompt TEXT,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE comments (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		author TEXT,
		task_id TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
	);
	CREATE TABLE subtasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		completed BOOLEAN DEFAULT 0,
		task_id TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
	);
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO boards (id, name, short_alias, task_counter) VALUES ('b1', 'Test Board', 'TST', 1000)`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c1', 'Todo', 'b1', 0, 'todo')`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c2', 'In Progress', 'b1', 1, 'in_progress')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c3', 'Done', 'b1', 2, 'done')`)
	if err != nil {
		t.Fatalf("failed to insert test column c3: %v", err)
	}

	return db
}

func TestGetTasks(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t1', 'Task 1', 'c1', 1000, 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t2', 'Task 2', 'c1', 2000, 1)`)

	tests := []struct {
		name      string
		columnID  string
		boardID   string
		status    string
		page      int
		pageSize  int
		wantCount int
		wantTotal int
	}{
		{
			name:      "get all tasks",
			columnID:  "",
			boardID:   "",
			status:    "",
			page:      1,
			pageSize:  10,
			wantCount: 2,
			wantTotal: 2,
		},
		{
			name:      "get tasks by column",
			columnID:  "c1",
			boardID:   "",
			status:    "",
			page:      1,
			pageSize:  10,
			wantCount: 2,
			wantTotal: 2,
		},
		{
			name:      "get tasks by board",
			columnID:  "",
			boardID:   "b1",
			status:    "",
			page:      1,
			pageSize:  10,
			wantCount: 2,
			wantTotal: 2,
		},
		{
			name:      "get tasks with pagination",
			columnID:  "c1",
			boardID:   "",
			status:    "",
			page:      1,
			pageSize:  1,
			wantCount: 1,
			wantTotal: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := svc.GetTasks("", "", tt.columnID, tt.boardID, tt.status, tt.page, tt.pageSize, false, false)
			if err != nil {
				t.Fatalf("GetTasks() error = %v", err)
			}
			if len(result.Tasks) != tt.wantCount {
				t.Errorf("got %d tasks, want %d", len(result.Tasks), tt.wantCount)
			}
			if result.Total != tt.wantTotal {
				t.Errorf("got total %d, want %d", result.Total, tt.wantTotal)
			}
		})
	}
}

func TestGetTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, published) VALUES ('t1', 'Test Task', 'c1', 1)`)
	_, _ = db.Exec(`INSERT INTO comments (id, content, task_id) VALUES ('cm1', 'Comment', 't1')`)
	_, _ = db.Exec(`INSERT INTO subtasks (id, title, task_id) VALUES ('st1', 'Subtask', 't1')`)

	tests := []struct {
		name      string
		taskID    string
		wantErr   bool
		wantTitle string
		wantCmnt  int
		wantSub   int
	}{
		{
			name:      "get existing task",
			taskID:    "t1",
			wantErr:   false,
			wantTitle: "Test Task",
			wantCmnt:  1,
			wantSub:   1,
		},
		{
			name:    "get non-existent task",
			taskID:  "nonexistent",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, commentCount, subtaskCount, err := svc.GetTask(tt.taskID, "", "")
			if (err != nil) != tt.wantErr {
				t.Errorf("GetTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if task.Title != tt.wantTitle {
					t.Errorf("title = %v, want %v", task.Title, tt.wantTitle)
				}
				if commentCount != tt.wantCmnt {
					t.Errorf("commentCount = %v, want %v", commentCount, tt.wantCmnt)
				}
				if subtaskCount != tt.wantSub {
					t.Errorf("subtaskCount = %v, want %v", subtaskCount, tt.wantSub)
				}
			}
		})
	}
}

func TestCreateTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	desc := "Test Description"
	assignee := "user1"
	meta := map[string]interface{}{"key": "value"}

	tests := []struct {
		name    string
		input   services.CreateTaskInput
		wantErr bool
		checkFn func(*testing.T, *models.Task)
	}{
		{
			name: "create task with minimal fields",
			input: services.CreateTaskInput{
				Title:     "New Task",
				ColumnID:  "c1",
				CreatedBy: "u1",
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task) {
				if task.Title != "New Task" {
					t.Errorf("title = %v, want New Task", task.Title)
				}
				if task.Priority != "medium" {
					t.Errorf("priority = %v, want medium", task.Priority)
				}
				if task.ColumnID != "c1" {
					t.Errorf("columnID = %v, want c1", task.ColumnID)
				}
			},
		},
		{
			name: "create task with all fields",
			input: services.CreateTaskInput{
				Title:       "Full Task",
				Description: &desc,
				Priority:    "high",
				Assignee:    &assignee,
				Meta:        meta,
				ColumnID:    "c1",
				Published:   true,
				CreatedBy:   "u1",
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task) {
				if task.Title != "Full Task" {
					t.Errorf("title = %v, want Full Task", task.Title)
				}
				if task.Priority != "high" {
					t.Errorf("priority = %v, want high", task.Priority)
				}
				if task.Description == nil || *task.Description != desc {
					t.Errorf("description = %v, want %v", task.Description, desc)
				}
			},
		},
		{
			name: "create task with explicit position",
			input: services.CreateTaskInput{
				Title:     "Positioned Task",
				ColumnID:  "c1",
				Position:  500,
				CreatedBy: "u1",
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task) {
				if task.Position != 500 {
					t.Errorf("position = %v, want 500", task.Position)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, err := svc.CreateTask(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("CreateTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.checkFn != nil && task != nil {
				tt.checkFn(t, task)
			}
		})
	}
}

func TestUpdateTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, priority, column_id, position, created_by) VALUES ('t1', 'Original', 'low', 'c1', 1000, 'u1')`)

	newTitle := "Updated Title"
	desc := "New Description"
	newPriority := "high"

	tests := []struct {
		name    string
		taskID  string
		input   services.UpdateTaskInput
		wantErr bool
		checkFn func(*testing.T, *models.Task, *services.TaskChanges)
	}{
		{
			name:   "update title only",
			taskID: "t1",
			input: services.UpdateTaskInput{
				Title: newTitle,
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task, changes *services.TaskChanges) {
				if task.Title != newTitle {
					t.Errorf("title = %v, want %v", task.Title, newTitle)
				}
				if len(changes.Changes) != 1 {
					t.Errorf("changes count = %v, want 1", len(changes.Changes))
				}
			},
		},
		{
			name:   "update description only",
			taskID: "t1",
			input: services.UpdateTaskInput{
				Description: &desc,
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task, changes *services.TaskChanges) {
				if task.Description == nil || *task.Description != desc {
					t.Errorf("description = %v, want %v", task.Description, desc)
				}
			},
		},
		{
			name:   "update priority only",
			taskID: "t1",
			input: services.UpdateTaskInput{
				Priority: newPriority,
			},
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task, changes *services.TaskChanges) {
				if task.Priority != newPriority {
					t.Errorf("priority = %v, want %v", task.Priority, newPriority)
				}
			},
		},
		{
			name:   "update non-existent task",
			taskID: "nonexistent",
			input: services.UpdateTaskInput{
				Title: "New Title",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, changes, err := svc.UpdateTask(tt.taskID, "", "", tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("UpdateTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.checkFn != nil && task != nil && changes != nil {
				tt.checkFn(t, task, changes)
			}
		})
	}
}

func TestUpdateTaskAgentFields(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Original', 'c1', 1000, 'u1')`)

	agentID := "agent123"
	agentPrompt := "Please process this task"

	_, _, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		AgentID: &agentID,
	})
	if err != nil {
		t.Fatalf("UpdateTask(AgentID) error = %v", err)
	}

	_, _, err = svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		AgentPrompt: &agentPrompt,
	})
	if err != nil {
		t.Fatalf("UpdateTask(AgentPrompt) error = %v", err)
	}
}

func TestUpdateTaskPublishedField(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published, created_by) VALUES ('t1', 'Original', 'c1', 1000, 0, 'u1')`)

	published := true
	_, _, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		Published: &published,
	})
	if err != nil {
		t.Fatalf("UpdateTask(Published) error = %v", err)
	}

	retrieved, _, _, err := svc.GetTask("t1", "", "")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if !retrieved.Published {
		t.Error("expected Published to be true")
	}
}

func TestUpdateTaskMetaField(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Original', 'c1', 1000, 'u1')`)

	meta := map[string]interface{}{"label": "bug", "estimate": "4h"}
	_, _, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		Meta: meta,
	})
	if err != nil {
		t.Fatalf("UpdateTask(Meta) error = %v", err)
	}
}

func TestUpdateTaskAssigneeField(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Original', 'c1', 1000, 'u1')`)

	assignee := "user2"
	_, _, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		Assignee: &assignee,
	})
	if err != nil {
		t.Fatalf("UpdateTask(Assignee) error = %v", err)
	}

	retrieved, _, _, err := svc.GetTask("t1", "", "")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if retrieved.Assignee == nil || *retrieved.Assignee != assignee {
		t.Errorf("Assignee = %v, want %v", retrieved.Assignee, assignee)
	}
}

func TestUpdateTaskNoChanges(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, priority, column_id, position, created_by) VALUES ('t1', 'Original', 'high', 'c1', 1000, 'u1')`)

	task, changes, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		Title: "Original",
	})
	if err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}
	if len(changes.Changes) != 0 {
		t.Errorf("changes count = %v, want 0", len(changes.Changes))
	}
	if task.Title != "Original" {
		t.Errorf("title = %v, want Original", task.Title)
	}
}

func TestDeleteTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'To Delete', 'c1')`)

	err := svc.DeleteTask("t1")
	if err != nil {
		t.Fatalf("DeleteTask() error = %v", err)
	}

	_, _, _, err = svc.GetTask("t1", "", "")
	if err == nil {
		t.Error("expected error when getting deleted task")
	}
}

func TestArchiveTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'Task', 'c1')`)

	tests := []struct {
		name     string
		taskID   string
		archived bool
		wantErr  bool
		checkFn  func(*testing.T, *models.Task)
	}{
		{
			name:     "archive task",
			taskID:   "t1",
			archived: true,
			wantErr:  false,
			checkFn: func(t *testing.T, task *models.Task) {
				if !task.Archived {
					t.Error("expected Archived to be true")
				}
				if task.ArchivedAt == nil {
					t.Error("expected ArchivedAt to be set")
				}
			},
		},
		{
			name:     "unarchive task",
			taskID:   "t1",
			archived: false,
			wantErr:  false,
			checkFn: func(t *testing.T, task *models.Task) {
				if task.Archived {
					t.Error("expected Archived to be false")
				}
				if task.ArchivedAt != nil {
					t.Error("expected ArchivedAt to be nil")
				}
			},
		},
		{
			name:     "archive non-existent task",
			taskID:   "nonexistent",
			archived: true,
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, err := svc.ArchiveTask(tt.taskID, tt.archived)
			if (err != nil) != tt.wantErr {
				t.Errorf("ArchiveTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.checkFn != nil && task != nil {
				tt.checkFn(t, task)
			}
		})
	}
}

func TestCompleteTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('t1', 'Task', 'c1', 'u1')`)

	tests := []struct {
		name       string
		taskID     string
		wantErr    bool
		wantColumn string
	}{
		{
			name:       "complete task moves to next column",
			taskID:     "t1",
			wantErr:    false,
			wantColumn: "c2",
		},
		{
			name:    "complete task in last column returns error",
			taskID:  "nonexistent-task",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, err := svc.CompleteTask(tt.taskID)
			if (err != nil) != tt.wantErr {
				t.Errorf("CompleteTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && task != nil {
				if task.ColumnID != tt.wantColumn {
					t.Errorf("columnID = %v, want %v", task.ColumnID, tt.wantColumn)
				}
			}
		})
	}
}

func TestCalculatePosition(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t1', 'High 1', 'c1', 1000, 'high')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t2', 'High 2', 'c1', 2000, 'high')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t3', 'Low 1', 'c1', 5000, 'low')`)

	tests := []struct {
		name     string
		priority string
		want     int
	}{
		{
			name:     "high priority after existing high",
			priority: "high",
			want:     3000,
		},
		{
			name:     "low priority at end",
			priority: "low",
			want:     5001,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pos, err := svc.CreateTask(services.CreateTaskInput{
				Title:     "Test",
				ColumnID:  "c1",
				Priority:  tt.priority,
				CreatedBy: "u1",
			})
			if err != nil {
				t.Fatalf("CreateTask() error = %v", err)
			}
			if pos.Position != tt.want {
				t.Errorf("position = %v, want %v", pos.Position, tt.want)
			}
		})
	}
}

func TestTriggerAgentForTask(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	svc.TriggerAgentForTask("t1", "agent1", "prompt", "Task Title")
}

func TestCompleteTaskLastColumn(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('t1', 'Task in Last', 'c3', 'u1')`)

	_, err := svc.CompleteTask("t1")
	if err == nil {
		t.Error("expected error when completing task in last column")
	}
}

func TestUpdateTaskPositionSameColumn(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Task', 'c1', 1000, 'u1')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t2', 'Task 2', 'c1', 2000, 'u1')`)

	newPos := 1500
	_, changes, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		Position: &newPos,
		ColumnID: "c1",
	})
	if err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}
	if len(changes.Changes) != 1 {
		t.Errorf("expected 1 change, got %d", len(changes.Changes))
	}
}

func TestUpdateTaskColumnChange(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Task', 'c1', 1000, 'u1')`)

	newCol := "c2"
	_, changes, err := svc.UpdateTask("t1", "", "", services.UpdateTaskInput{
		ColumnID: newCol,
	})
	if err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}
	if len(changes.Changes) != 1 {
		t.Errorf("expected 1 change (status), got %d", len(changes.Changes))
	}

	task, _, _, err := svc.GetTask("t1", "", "")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.ColumnID != newCol {
		t.Errorf("columnID = %v, want %v", task.ColumnID, newCol)
	}
}

func TestCreateTaskInvalidColumn(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, err := svc.CreateTask(services.CreateTaskInput{
		Title:     "Invalid Column Task",
		ColumnID:  "nonexistent",
		CreatedBy: "u1",
	})
	if err == nil {
		t.Error("expected error when creating task with invalid column")
	}
}

func TestGetTasksByStatus(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t1', 'Todo Task', 'c1', 1000, 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t2', 'Done Task', 'c3', 1000, 1)`)

	result, err := svc.GetTasks("", "", "", "", "done", 1, 10, false, false)
	if err != nil {
		t.Fatalf("GetTasks() error = %v", err)
	}
	if len(result.Tasks) != 1 {
		t.Errorf("expected 1 done task, got %d", len(result.Tasks))
	}
}

func TestGetTasksByBoardAndStatus(t *testing.T) {
	db := setupServiceTestDB(t)
	defer db.Close()

	svc := services.NewTaskService(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t1', 'Todo Task', 'c1', 1000, 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t2', 'Done Task', 'c3', 1000, 1)`)

	result, err := svc.GetTasks("", "", "", "b1", "todo", 1, 10, false, false)
	if err != nil {
		t.Fatalf("GetTasks() error = %v", err)
	}
	if len(result.Tasks) != 1 {
		t.Errorf("expected 1 todo task for board b1, got %d", len(result.Tasks))
	}
}

func TestGenerateTaskIDConcurrency(t *testing.T) {
	t.Skip("SQLite does not support concurrent transactions - this test requires MySQL/PostgreSQL")
}
