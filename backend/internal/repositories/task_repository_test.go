package repositories_test

import (
	"database/sql"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
)

func setupTestDB(t *testing.T) *sql.DB {
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
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c2', 'Done', 'b1', 1, 'done')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}

	return db
}

func TestGetTaskByID(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, err := db.Exec(`INSERT INTO tasks (id, title, description, priority, column_id, position, published, archived, created_by)
		VALUES ('t1', 'Test Task', 'Description', 'high', 'c1', 1000, 1, 0, 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	tests := []struct {
		name    string
		taskID  string
		wantErr bool
		checkFn func(*testing.T, *models.Task)
	}{
		{
			name:    "get existing task",
			taskID:  "t1",
			wantErr: false,
			checkFn: func(t *testing.T, task *models.Task) {
				if task.Title != "Test Task" {
					t.Errorf("expected title 'Test Task', got '%s'", task.Title)
				}
				if task.Priority != "high" {
					t.Errorf("expected priority 'high', got '%s'", task.Priority)
				}
				if task.Position != 1000 {
					t.Errorf("expected position 1000, got %d", task.Position)
				}
				if !task.Published {
					t.Error("expected published to be true")
				}
				if task.Description == nil || *task.Description != "Description" {
					t.Errorf("expected description 'Description', got %v", task.Description)
				}
			},
		},
		{
			name:    "get non-existent task returns error",
			taskID:  "nonexistent",
			wantErr: true,
			checkFn: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			task, err := repo.GetTaskByID(tt.taskID)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetTaskByID() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.checkFn != nil && task != nil {
				tt.checkFn(t, task)
			}
		})
	}
}

func TestCreateTask(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	now := time.Now()
	task := &models.Task{
		ID:          "t-new",
		Title:       "New Task",
		Description: strPtr("New Description"),
		Priority:    "medium",
		Assignee:    strPtr("user1"),
		Meta:        strPtr(`{"key":"value"}`),
		ColumnID:    "c1",
		Position:    100,
		Published:   true,
		Archived:    false,
		AgentID:     strPtr("agent1"),
		AgentPrompt: strPtr("prompt"),
		CreatedBy:   "u1",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	err := repo.CreateTask(task)
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	retrieved, err := repo.GetTaskByID("t-new")
	if err != nil {
		t.Fatalf("GetTaskByID() after create error = %v", err)
	}
	if retrieved.Title != "New Task" {
		t.Errorf("expected title 'New Task', got '%s'", retrieved.Title)
	}
	if retrieved.Priority != "medium" {
		t.Errorf("expected priority 'medium', got '%s'", retrieved.Priority)
	}
	if retrieved.Position != 100 {
		t.Errorf("expected position 100, got %d", retrieved.Position)
	}
}

func TestUpdateTask(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, err := db.Exec(`INSERT INTO tasks (id, title, priority, column_id, position) VALUES ('t1', 'Original', 'low', 'c1', 100)`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	newTitle := "Updated Title"
	newPriority := "high"
	task := &models.Task{
		ID:       "t1",
		Title:    newTitle,
		Priority: newPriority,
		ColumnID: "c1",
		Position: 200,
	}

	err = repo.UpdateTask(task)
	if err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}

	retrieved, err := repo.GetTaskByID("t1")
	if err != nil {
		t.Fatalf("GetTaskByID() after update error = %v", err)
	}
	if retrieved.Title != newTitle {
		t.Errorf("expected title '%s', got '%s'", newTitle, retrieved.Title)
	}
	if retrieved.Priority != newPriority {
		t.Errorf("expected priority '%s', got '%s'", newPriority, retrieved.Priority)
	}
}

func TestDeleteTask(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'To Delete', 'c1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	err = repo.DeleteTask("t1")
	if err != nil {
		t.Fatalf("DeleteTask() error = %v", err)
	}

	_, err = repo.GetTaskByID("t1")
	if err == nil {
		t.Error("expected error when getting deleted task")
	}
}

func TestGetTasksByColumnIDs(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t1', 'Task 1', 'c1', 100, 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t2', 'Task 2', 'c1', 200, 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t3', 'Task 3', 'c2', 100, 1)`)

	tests := []struct {
		name       string
		columnIDs  []string
		page       int
		pageSize   int
		wantCount  int
		wantTotal  int
		wantTitles []string
	}{
		{
			name:       "get tasks for single column",
			columnIDs:  []string{"c1"},
			page:       1,
			pageSize:   10,
			wantCount:  2,
			wantTotal:  2,
			wantTitles: []string{"Task 1", "Task 2"},
		},
		{
			name:       "get tasks for multiple columns",
			columnIDs:  []string{"c1", "c2"},
			page:       1,
			pageSize:   10,
			wantCount:  3,
			wantTotal:  3,
			wantTitles: []string{"Task 1", "Task 2", "Task 3"},
		},
		{
			name:       "get tasks with pagination",
			columnIDs:  []string{"c1"},
			page:       1,
			pageSize:   1,
			wantCount:  1,
			wantTotal:  2,
			wantTitles: []string{"Task 1"},
		},
		{
			name:       "get tasks empty column",
			columnIDs:  []string{"c2"},
			page:       1,
			pageSize:   10,
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Task 3"},
		},
		{
			name:       "get all tasks with empty columnIDs",
			columnIDs:  []string{},
			page:       1,
			pageSize:   10,
			wantCount:  3,
			wantTotal:  3,
			wantTitles: []string{"Task 1", "Task 2", "Task 3"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tasks, total, err := repo.GetTasksByColumnIDs(tt.columnIDs, tt.page, tt.pageSize, false, false)
			if err != nil {
				t.Fatalf("GetTasksByColumnIDs() error = %v", err)
			}
			if len(tasks) != tt.wantCount {
				t.Errorf("got %d tasks, want %d", len(tasks), tt.wantCount)
			}
			if total != tt.wantTotal {
				t.Errorf("got total %d, want %d", total, tt.wantTotal)
			}
		})
	}
}

func TestGetColumnIDForTask(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'Task', 'c1')`)

	tests := []struct {
		name    string
		taskID  string
		want    string
		wantErr bool
	}{
		{
			name:    "get column id for existing task",
			taskID:  "t1",
			want:    "c1",
			wantErr: false,
		},
		{
			name:    "get column id for non-existent task",
			taskID:  "nonexistent",
			want:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			columnID, err := repo.GetColumnIDForTask(tt.taskID)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetColumnIDForTask() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if columnID != tt.want {
				t.Errorf("GetColumnIDForTask() = %v, want %v", columnID, tt.want)
			}
		})
	}
}

func TestGetMaxPosition(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 1000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 2000)`)

	tests := []struct {
		name     string
		columnID string
		want     int
	}{
		{
			name:     "get max position for column with tasks",
			columnID: "c1",
			want:     2000,
		},
		{
			name:     "get max position for empty column",
			columnID: "c2",
			want:     0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			maxPos, err := repo.GetMaxPosition(tt.columnID)
			if err != nil {
				t.Fatalf("GetMaxPosition() error = %v", err)
			}
			if maxPos != tt.want {
				t.Errorf("GetMaxPosition() = %d, want %d", maxPos, tt.want)
			}
		})
	}
}

func TestGetMaxPositionForPriority(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t1', 'High 1', 'c1', 1000, 'high')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t2', 'High 2', 'c1', 2000, 'high')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t3', 'Low 1', 'c1', 500, 'low')`)

	tests := []struct {
		name     string
		columnID string
		priority string
		want     int
	}{
		{
			name:     "get max position for high priority",
			columnID: "c1",
			priority: "high",
			want:     2000,
		},
		{
			name:     "get max position for low priority",
			columnID: "c1",
			priority: "low",
			want:     500,
		},
		{
			name:     "get max position for non-existent priority",
			columnID: "c1",
			priority: "medium",
			want:     0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			maxPos, err := repo.GetMaxPositionForPriority(tt.columnID, tt.priority)
			if err != nil {
				t.Fatalf("GetMaxPositionForPriority() error = %v", err)
			}
			if maxPos != tt.want {
				t.Errorf("GetMaxPositionForPriority() = %d, want %d", maxPos, tt.want)
			}
		})
	}
}

func TestGetMinPositionForLowPriority(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t1', 'Low 1', 'c1', 1000, 'low')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position, priority) VALUES ('t2', 'Low 2', 'c1', 2000, 'low')`)

	tests := []struct {
		name     string
		columnID string
		want     int
	}{
		{
			name:     "get min position for column with low priority tasks",
			columnID: "c1",
			want:     1000,
		},
		{
			name:     "get min position for column without low priority tasks",
			columnID: "c2",
			want:     0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			minPos, err := repo.GetMinPositionForLowPriority(tt.columnID)
			if err != nil {
				t.Fatalf("GetMinPositionForLowPriority() error = %v", err)
			}
			if minPos != tt.want {
				t.Errorf("GetMinPositionForLowPriority() = %d, want %d", minPos, tt.want)
			}
		})
	}
}

func TestGetTaskCommentCount(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'Task', 'c1')`)
	_, _ = db.Exec(`INSERT INTO comments (id, content, task_id) VALUES ('cm1', 'Comment 1', 't1')`)
	_, _ = db.Exec(`INSERT INTO comments (id, content, task_id) VALUES ('cm2', 'Comment 2', 't1')`)

	tests := []struct {
		name    string
		taskID  string
		want    int
		wantErr bool
	}{
		{
			name:    "get comment count for task with comments",
			taskID:  "t1",
			want:    2,
			wantErr: false,
		},
		{
			name:    "get comment count for non-existent task returns 0",
			taskID:  "nonexistent",
			want:    0,
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			count, err := repo.GetTaskCommentCount(tt.taskID)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetTaskCommentCount() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if count != tt.want {
				t.Errorf("GetTaskCommentCount() = %d, want %d", count, tt.want)
			}
		})
	}
}

func TestGetTaskSubtaskCount(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'Task', 'c1')`)
	_, _ = db.Exec(`INSERT INTO subtasks (id, title, task_id) VALUES ('st1', 'Subtask 1', 't1')`)
	_, _ = db.Exec(`INSERT INTO subtasks (id, title, task_id) VALUES ('st2', 'Subtask 2', 't1')`)

	tests := []struct {
		name    string
		taskID  string
		want    int
		wantErr bool
	}{
		{
			name:    "get subtask count for task with subtasks",
			taskID:  "t1",
			want:    2,
			wantErr: false,
		},
		{
			name:    "get subtask count for non-existent task returns 0",
			taskID:  "nonexistent",
			want:    0,
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			count, err := repo.GetTaskSubtaskCount(tt.taskID)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetTaskSubtaskCount() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if count != tt.want {
				t.Errorf("GetTaskSubtaskCount() = %d, want %d", count, tt.want)
			}
		})
	}
}

func TestGetNextColumn(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	tests := []struct {
		name         string
		boardID      string
		currentPos   int
		wantColumnID string
	}{
		{
			name:         "get next column",
			boardID:      "b1",
			currentPos:   0,
			wantColumnID: "c2",
		},
		{
			name:         "get next column at last position",
			boardID:      "b1",
			currentPos:   1,
			wantColumnID: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nextColumnID, err := repo.GetNextColumn(tt.boardID, tt.currentPos)
			if err != nil {
				t.Fatalf("GetNextColumn() error = %v", err)
			}
			if nextColumnID != tt.wantColumnID {
				t.Errorf("GetNextColumn() = %v, want %v", nextColumnID, tt.wantColumnID)
			}
		})
	}
}

func TestMoveTaskToColumn(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t1', 'Task', 'c1')`)

	err := repo.MoveTaskToColumn("t1", "c2", 1000)
	if err != nil {
		t.Fatalf("MoveTaskToColumn() error = %v", err)
	}

	columnID, err := repo.GetColumnIDForTask("t1")
	if err != nil {
		t.Fatalf("GetColumnIDForTask() error = %v", err)
	}
	if columnID != "c2" {
		t.Errorf("task column_id = %v, want c2", columnID)
	}

	task, err := repo.GetTaskByID("t1")
	if err != nil {
		t.Fatalf("GetTaskByID() error = %v", err)
	}
	if task.Position != 1000 {
		t.Errorf("task position = %v, want 1000", task.Position)
	}
}

func TestGetColumnPositionAndBoardID(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	tests := []struct {
		name      string
		columnID  string
		wantPos   int
		wantBoard string
		wantErr   bool
	}{
		{
			name:      "get column position and board id",
			columnID:  "c1",
			wantPos:   0,
			wantBoard: "b1",
			wantErr:   false,
		},
		{
			name:      "get for non-existent column",
			columnID:  "nonexistent",
			wantPos:   0,
			wantBoard: "",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pos, boardID, err := repo.GetColumnPositionAndBoardID(tt.columnID)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetColumnPositionAndBoardID() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if pos != tt.wantPos {
				t.Errorf("position = %d, want %d", pos, tt.wantPos)
			}
			if boardID != tt.wantBoard {
				t.Errorf("boardID = %v, want %v", boardID, tt.wantBoard)
			}
		})
	}
}

func TestShiftPositionsUp(t *testing.T) {
	t.Skip("ShiftPositionsUp uses NOW() which is not available in SQLite in-memory mode")
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 1000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 2000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t3', 'Task 3', 'c1', 3000)`)

	err := repo.ShiftPositionsUp("c1", 1500, 2500, "t3")
	if err != nil {
		t.Fatalf("ShiftPositionsUp() error = %v", err)
	}

	task, _ := repo.GetTaskByID("t2")
	if task.Position != 2501 {
		t.Errorf("t2 position = %d, want 2501", task.Position)
	}
}

func TestShiftPositionsDown(t *testing.T) {
	t.Skip("ShiftPositionsDown uses NOW() which is not available in SQLite in-memory mode")
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 1000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 2000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t3', 'Task 3', 'c1', 3000)`)

	err := repo.ShiftPositionsDown("c1", 1000, 2000, "t3")
	if err != nil {
		t.Fatalf("ShiftPositionsDown() error = %v", err)
	}

	task, _ := repo.GetTaskByID("t2")
	if task.Position != 999 {
		t.Errorf("t2 position = %d, want 999", task.Position)
	}
}

func TestShiftPositionsLeft(t *testing.T) {
	t.Skip("ShiftPositionsLeft uses NOW() which is not available in SQLite in-memory mode")
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 1000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 2000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t3', 'Task 3', 'c1', 3000)`)

	err := repo.ShiftPositionsLeft("c1", 2000)
	if err != nil {
		t.Fatalf("ShiftPositionsLeft() error = %v", err)
	}

	task, _ := repo.GetTaskByID("t3")
	if task.Position != 2999 {
		t.Errorf("t3 position = %d, want 2999", task.Position)
	}
}

func TestShiftPositionsRight(t *testing.T) {
	t.Skip("ShiftPositionsRight uses NOW() which is not available in SQLite in-memory mode")
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 1000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 2000)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t3', 'Task 3', 'c1', 3000)`)

	err := repo.ShiftPositionsRight("c1", 2000, "t1")
	if err != nil {
		t.Fatalf("ShiftPositionsRight() error = %v", err)
	}

	task, _ := repo.GetTaskByID("t3")
	if task.Position != 3001 {
		t.Errorf("t3 position = %d, want 3001", task.Position)
	}
}

func TestSearchTasks(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	repo := repositories.NewTaskRepository(db)

	_, _ = db.Exec(`INSERT INTO tasks (id, title, description, priority, column_id, position, published, archived, created_by) VALUES ('t1', 'Bug Report', 'Something is broken', 'high', 'c1', 100, 1, 0, 'u1')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, description, priority, column_id, position, published, archived, created_by) VALUES ('t2', 'Feature Request', 'Add new feature', 'medium', 'c1', 200, 1, 0, 'u1')`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, description, priority, column_id, position, published, archived, created_by) VALUES ('t3', 'Task Three', 'Description for task three', 'low', 'c2', 100, 1, 0, 'u1')`)
	_, _ = db.Exec(`INSERT INTO comments (id, content, task_id) VALUES ('cm1', 'This is a comment about the bug', 't1')`)
	_, _ = db.Exec(`INSERT INTO subtasks (id, title, task_id) VALUES ('st1', 'Subtask 1', 't1')`)

	tests := []struct {
		name       string
		params     repositories.TaskSearchParams
		wantCount  int
		wantTotal  int
		wantTitles []string
	}{
		{
			name:       "search by title keyword",
			params:     repositories.TaskSearchParams{Query: "Bug", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Bug Report"},
		},
		{
			name:       "search by description keyword",
			params:     repositories.TaskSearchParams{Query: "broken", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Bug Report"},
		},
		{
			name:       "search by comment content",
			params:     repositories.TaskSearchParams{Query: "comment", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Bug Report"},
		},
		{
			name:       "search by meta keyword",
			params:     repositories.TaskSearchParams{Query: "meta", Page: 1, PageSize: 10},
			wantCount:  0,
			wantTotal:  0,
			wantTitles: []string{},
		},
		{
			name:       "search with no query returns all tasks",
			params:     repositories.TaskSearchParams{Page: 1, PageSize: 10},
			wantCount:  3,
			wantTotal:  3,
			wantTitles: []string{},
		},
		{
			name:       "filter by priority",
			params:     repositories.TaskSearchParams{Priority: "high", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Bug Report"},
		},
		{
			name:       "filter by status (column status)",
			params:     repositories.TaskSearchParams{Status: "done", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Task Three"},
		},
		{
			name:       "filter by board_id",
			params:     repositories.TaskSearchParams{BoardID: "b1", Page: 1, PageSize: 10},
			wantCount:  3,
			wantTotal:  3,
			wantTitles: []string{},
		},
		{
			name:       "pagination",
			params:     repositories.TaskSearchParams{Page: 1, PageSize: 2},
			wantCount:  2,
			wantTotal:  3,
			wantTitles: []string{},
		},
		{
			name:       "pagination page 2",
			params:     repositories.TaskSearchParams{Page: 2, PageSize: 2},
			wantCount:  1,
			wantTotal:  3,
			wantTitles: []string{},
		},
		{
			name:       "search by task ID",
			params:     repositories.TaskSearchParams{TaskID: "t2", Page: 1, PageSize: 10},
			wantCount:  1,
			wantTotal:  1,
			wantTitles: []string{"Feature Request"},
		},
		{
			name:       "search by task ID not found",
			params:     repositories.TaskSearchParams{TaskID: "nonexistent", Page: 1, PageSize: 10},
			wantCount:  0,
			wantTotal:  0,
			wantTitles: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tasks, total, err := repo.SearchTasks(tt.params)
			if err != nil {
				t.Fatalf("SearchTasks() error = %v", err)
			}
			if len(tasks) != tt.wantCount {
				t.Errorf("got %d tasks, want %d", len(tasks), tt.wantCount)
			}
			if total != tt.wantTotal {
				t.Errorf("got total %d, want %d", total, tt.wantTotal)
			}
			if len(tt.wantTitles) > 0 {
				for i, wantTitle := range tt.wantTitles {
					if i < len(tasks) && tasks[i].Title != wantTitle {
						t.Errorf("task[%d].title = %v, want %v", i, tasks[i].Title, wantTitle)
					}
				}
			}
		})
	}
}

func strPtr(s string) *string {
	return &s
}
