package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupDashboardDB(t *testing.T) *sql.DB {
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
		type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
		role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		user_id TEXT NOT NULL,
		expires_at DATETIME,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		short_alias TEXT UNIQUE,
		task_counter INTEGER DEFAULT 1000,
		deleted BOOLEAN DEFAULT 0,
		is_public BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		description TEXT DEFAULT ''
	);
	CREATE TABLE board_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
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
	CREATE TABLE column_agents (
		id TEXT PRIMARY KEY,
		column_id TEXT UNIQUE NOT NULL,
		agent_types TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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
		due_at DATETIME,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT', 'APP_CONFIG_UPDATE', 'PERMISSION_GRANT', 'PERMISSION_REVOKE')),
		target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE comments (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		author TEXT DEFAULT 'Anonymous',
		task_id TEXT NOT NULL,
		user_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
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
	CREATE TABLE attachments (
		id TEXT PRIMARY KEY,
		filename TEXT NOT NULL,
		storage_path TEXT NOT NULL,
		storage_type TEXT DEFAULT 'local',
		mime_type TEXT,
		size INTEGER,
		uploader_id TEXT,
		task_id TEXT,
		comment_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
		FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
	);
	CREATE TABLE templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		board_id TEXT,
		columns_config TEXT NOT NULL,
		include_tasks BOOLEAN DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	CREATE TABLE column_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE,
		UNIQUE(user_id, column_id)
	);

	CREATE INDEX IF NOT EXISTS idx_tasks_column_archived ON tasks(column_id, archived);
	CREATE INDEX IF NOT EXISTS idx_tasks_column_position ON tasks(column_id, position);
	CREATE INDEX IF NOT EXISTS idx_tokens_expires_at ON tokens(expires_at);
	CREATE INDEX IF NOT EXISTS idx_activities_action_target ON activities(action, target_type);
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES ('u1', 'admin', 'admin', 'pass', '😊', 'HUMAN', 'ADMIN', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test user admin: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES ('u2', 'member', 'member', 'pass', '😎', 'HUMAN', 'MEMBER', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test user member: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, name, key, user_id, expires_at) VALUES ('t1', 'default', 'admin-token', 'u1', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, task_counter) VALUES ('b1', 'Test Board', 1000)`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('c1', 'Todo', 'todo', 0, 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('c2', 'In Progress', 'in_progress', 1, 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('c3', 'Done', 'done', 2, 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c3: %v", err)
	}

	return db
}

func TestGetDashboardStatsHandler(t *testing.T) {
	db := setupDashboardDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/dashboard/stats", handlers.GetDashboardStats(db))

	t.Run("get dashboard stats without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get dashboard stats with auth returns stats", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if resp["totalTasks"] == nil {
			t.Errorf("expected totalTasks in response")
		}
		if resp["tasksByStatus"] == nil {
			t.Errorf("expected tasksByStatus in response")
		}
		if resp["tasksByPriority"] == nil {
			t.Errorf("expected tasksByPriority in response")
		}
		if resp["totalBoards"] == nil {
			t.Errorf("expected totalBoards in response")
		}
		if resp["totalColumns"] == nil {
			t.Errorf("expected totalColumns in response")
		}
		if resp["totalUsers"] == nil {
			t.Errorf("expected totalUsers in response")
		}
	})

	t.Run("get dashboard stats with no tasks returns zero counts", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if int(resp["totalTasks"].(float64)) != 0 {
			t.Errorf("expected totalTasks=0, got %v", resp["totalTasks"])
		}
		if int(resp["publishedTasks"].(float64)) != 0 {
			t.Errorf("expected publishedTasks=0, got %v", resp["publishedTasks"])
		}
		if int(resp["draftTasks"].(float64)) != 0 {
			t.Errorf("expected draftTasks=0, got %v", resp["draftTasks"])
		}
		if int(resp["archivedTasks"].(float64)) != 0 {
			t.Errorf("expected archivedTasks=0, got %v", resp["archivedTasks"])
		}
	})

	t.Run("get dashboard stats with tasks returns correct counts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived) VALUES ('t1', 'Task 1', 'c1', 'high', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert task t1: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived) VALUES ('t2', 'Task 2', 'c1', 'medium', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert task t2: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived) VALUES ('t3', 'Task 3', 'c2', 'low', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert task t3: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, archived_at) VALUES ('t4', 'Task 4', 'c1', 'high', 1, 1, datetime('now'))`)
		if err != nil {
			t.Fatalf("failed to insert archived task t4: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if int(resp["totalTasks"].(float64)) != 3 {
			t.Errorf("expected totalTasks=3, got %v", resp["totalTasks"])
		}
		if int(resp["publishedTasks"].(float64)) != 2 {
			t.Errorf("expected publishedTasks=2, got %v", resp["publishedTasks"])
		}
		if int(resp["draftTasks"].(float64)) != 1 {
			t.Errorf("expected draftTasks=1, got %v", resp["draftTasks"])
		}
		if int(resp["archivedTasks"].(float64)) != 1 {
			t.Errorf("expected archivedTasks=1, got %v", resp["archivedTasks"])
		}

		tasksByPriority := resp["tasksByPriority"].(map[string]interface{})
		if int(tasksByPriority["high"].(float64)) != 1 {
			t.Errorf("expected high priority count=1, got %v", tasksByPriority["high"])
		}
		if int(tasksByPriority["medium"].(float64)) != 1 {
			t.Errorf("expected medium priority count=1, got %v", tasksByPriority["medium"])
		}
		if int(tasksByPriority["low"].(float64)) != 1 {
			t.Errorf("expected low priority count=1, got %v", tasksByPriority["low"])
		}
	})

	t.Run("get dashboard stats tasks by status", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, archived) VALUES ('t5', 'Todo Task', 'c1', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert todo task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, published, archived) VALUES ('t6', 'In Progress Task', 'c2', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert in progress task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		tasksByStatus := resp["tasksByStatus"].(map[string]interface{})
		if tasksByStatus["todo"] == nil {
			t.Errorf("expected todo status in tasksByStatus, got nil")
		}
		if tasksByStatus["in_progress"] == nil {
			t.Errorf("expected in_progress status in tasksByStatus, got nil")
		}
	})

	t.Run("activeBoardCount mirrors totalBoards", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if int(resp["activeBoardCount"].(float64)) != int(resp["totalBoards"].(float64)) {
			t.Errorf("expected activeBoardCount == totalBoards (%v), got %v",
				resp["totalBoards"], resp["activeBoardCount"])
		}
	})

	t.Run("activeBoardCount excludes soft-deleted boards", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO boards (id, name, task_counter, deleted) VALUES ('b2', 'Deleted Board', 1000, 1)`)
		if err != nil {
			t.Fatalf("failed to insert deleted board: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if int(resp["activeBoardCount"].(float64)) != 1 {
			t.Errorf("expected activeBoardCount=1 (excluding deleted board), got %v", resp["activeBoardCount"])
		}
		if int(resp["totalBoards"].(float64)) != 1 {
			t.Errorf("expected totalBoards=1 (excluding deleted board), got %v", resp["totalBoards"])
		}
	})

	t.Run("tasksCompletedLast7Days counts COMPLETE_TASK activities in window", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, source, created_at) VALUES ('ac1', 'u1', 'COMPLETE_TASK', 'TASK', 't1', 'Task 1', 'web', datetime('now', '-1 day'))`)
		if err != nil {
			t.Fatalf("failed to insert recent completion activity: %v", err)
		}
		_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, source, created_at) VALUES ('ac2', 'u1', 'COMPLETE_TASK', 'TASK', 't2', 'Task 2', 'web', datetime('now', '-3 days'))`)
		if err != nil {
			t.Fatalf("failed to insert 3-day-old completion: %v", err)
		}
		_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, source, created_at) VALUES ('ac3', 'u1', 'COMPLETE_TASK', 'TASK', 't3', 'Task 3', 'web', datetime('now', '-10 days'))`)
		if err != nil {
			t.Fatalf("failed to insert 10-day-old completion: %v", err)
		}
		_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, source, created_at) VALUES ('ac4', 'u1', 'CREATE_TASK', 'TASK', 't4', 'Task 4', 'web', datetime('now', '-1 day'))`)
		if err != nil {
			t.Fatalf("failed to insert non-completion activity: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if int(resp["tasksCompletedLast7Days"].(float64)) != 2 {
			t.Errorf("expected tasksCompletedLast7Days=2, got %v", resp["tasksCompletedLast7Days"])
		}
	})

	t.Run("topAgentsByActivity returns at most 3 agents ordered by activity", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO users (id, username, nickname, password, type, role, enabled) VALUES ('a1', 'agent1', 'Agent One', 'pass', 'AGENT', 'MEMBER', 1)`)
		if err != nil {
			t.Fatalf("failed to insert agent a1: %v", err)
		}
		_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, type, role, enabled) VALUES ('a2', 'agent2', 'Agent Two', 'pass', 'AGENT', 'MEMBER', 1)`)
		if err != nil {
			t.Fatalf("failed to insert agent a2: %v", err)
		}
		_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, type, role, enabled) VALUES ('a3', 'agent3', 'Agent Three', 'pass', 'AGENT', 'MEMBER', 1)`)
		if err != nil {
			t.Fatalf("failed to insert agent a3: %v", err)
		}
		_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, type, role, enabled) VALUES ('a4', 'agent4', 'Agent Four', 'pass', 'AGENT', 'MEMBER', 1)`)
		if err != nil {
			t.Fatalf("failed to insert agent a4: %v", err)
		}

		// a1: 5 activities, a2: 3, a3: 1, a4: 0
		for i := 0; i < 5; i++ {
			_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source, created_at) VALUES (?, 'a1', 'CREATE_TASK', 'TASK', 'web', datetime('now', '-1 day'))`, `act-a1-`+itoa(i))
			if err != nil {
				t.Fatalf("failed to insert a1 activity: %v", err)
			}
		}
		for i := 0; i < 3; i++ {
			_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source, created_at) VALUES (?, 'a2', 'CREATE_TASK', 'TASK', 'web', datetime('now', '-2 day'))`, `act-a2-`+itoa(i))
			if err != nil {
				t.Fatalf("failed to insert a2 activity: %v", err)
			}
		}
		_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source, created_at) VALUES ('act-a3-0', 'a3', 'CREATE_TASK', 'TASK', 'web', datetime('now', '-1 day'))`)
		if err != nil {
			t.Fatalf("failed to insert a3 activity: %v", err)
		}
		// a4 has none.
		// u1 (HUMAN) with 4 activities should NOT appear (only AGENT type).
		for i := 0; i < 4; i++ {
			_, err = db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source, created_at) VALUES (?, 'u1', 'CREATE_TASK', 'TASK', 'web', datetime('now', '-1 day'))`, `act-u1-`+itoa(i))
			if err != nil {
				t.Fatalf("failed to insert u1 activity: %v", err)
			}
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		agentsRaw := resp["topAgentsByActivity"].([]interface{})
		if len(agentsRaw) != 3 {
			t.Fatalf("expected 3 top agents, got %d", len(agentsRaw))
		}
		first := agentsRaw[0].(map[string]interface{})
		if first["userId"] != "a1" {
			t.Errorf("expected first agent to be a1, got %v", first["userId"])
		}
		if int(first["activityCount"].(float64)) != 5 {
			t.Errorf("expected a1 activityCount=5, got %v", first["activityCount"])
		}
		second := agentsRaw[1].(map[string]interface{})
		if second["userId"] != "a2" {
			t.Errorf("expected second agent to be a2, got %v", second["userId"])
		}
		third := agentsRaw[2].(map[string]interface{})
		if third["userId"] != "a3" {
			t.Errorf("expected third agent to be a3, got %v", third["userId"])
		}
	})

	t.Run("topAgentsByActivity excludes humans and old activities", func(t *testing.T) {
		// Fresh DB - re-use from previous subtest would be wrong; this subtest
		// already has the agents inserted; just verify activity > 7 days is excluded.
		_, err := db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source, created_at) VALUES ('act-old-a1', 'a1', 'CREATE_TASK', 'TASK', 'web', datetime('now', '-30 days'))`)
		if err != nil {
			t.Fatalf("failed to insert old activity: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		agentsRaw := resp["topAgentsByActivity"].([]interface{})
		if len(agentsRaw) != 3 {
			t.Fatalf("expected 3 agents, got %d", len(agentsRaw))
		}
		first := agentsRaw[0].(map[string]interface{})
		// Old activity (30d) should be excluded, so a1 still has 5.
		if int(first["activityCount"].(float64)) != 5 {
			t.Errorf("expected a1 activityCount=5 (excluding 30d-old), got %v", first["activityCount"])
		}
	})

	t.Run("longestBlockedCards returns oldest non-done, published, non-archived tasks", func(t *testing.T) {
		// Insert tasks with controlled updated_at to verify ordering.
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-old', 'Oldest Stale', 'c1', 'high', 1, 0, datetime('now', '-20 days'))`)
		if err != nil {
			t.Fatalf("failed to insert oldest blocked task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-mid', 'Mid Stale', 'c1', 'medium', 1, 0, datetime('now', '-10 days'))`)
		if err != nil {
			t.Fatalf("failed to insert mid blocked task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-recent', 'Recent Stale', 'c1', 'low', 1, 0, datetime('now', '-2 days'))`)
		if err != nil {
			t.Fatalf("failed to insert recent stale task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-done', 'Done Task', 'c3', 'high', 1, 0, datetime('now', '-30 days'))`)
		if err != nil {
			t.Fatalf("failed to insert done task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-archived', 'Archived Stale', 'c1', 'high', 1, 1, datetime('now', '-50 days'))`)
		if err != nil {
			t.Fatalf("failed to insert archived task: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, priority, published, archived, updated_at) VALUES ('bt-draft', 'Draft Stale', 'c1', 'medium', 0, 0, datetime('now', '-100 days'))`)
		if err != nil {
			t.Fatalf("failed to insert draft stale task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/dashboard/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		cardsRaw := resp["longestBlockedCards"].([]interface{})
		if len(cardsRaw) != 3 {
			t.Fatalf("expected 3 blocked cards, got %d", len(cardsRaw))
		}
		first := cardsRaw[0].(map[string]interface{})
		if first["taskId"] != "bt-old" {
			t.Errorf("expected first blocked card to be bt-old (oldest), got %v", first["taskId"])
		}
		if int(first["daysBlocked"].(float64)) < 19 {
			t.Errorf("expected daysBlocked >= 19 for bt-old, got %v", first["daysBlocked"])
		}
		second := cardsRaw[1].(map[string]interface{})
		if second["taskId"] != "bt-mid" {
			t.Errorf("expected second blocked card to be bt-mid, got %v", second["taskId"])
		}
		third := cardsRaw[2].(map[string]interface{})
		if third["taskId"] != "bt-recent" {
			t.Errorf("expected third blocked card to be bt-recent, got %v", third["taskId"])
		}

		// Verify excluded IDs aren't present.
		for _, c := range cardsRaw {
			id := c.(map[string]interface{})["taskId"]
			if id == "bt-done" || id == "bt-archived" || id == "bt-draft" {
				t.Errorf("expected excluded task %v to not appear in blocked cards", id)
			}
		}
	})
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	digits := ""
	for i > 0 {
		digits = string(rune('0'+i%10)) + digits
		i /= 10
	}
	return digits
}
