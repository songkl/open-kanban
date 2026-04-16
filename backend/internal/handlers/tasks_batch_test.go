package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupBatchTasksDB(t *testing.T) *sql.DB {
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
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
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
	CREATE TABLE column_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT', 'APP_CONFIG_UPDATE')),
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
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'test-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Test Board')`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c1', '待办', 'todo', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', '进行中', 'in_progress', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c3', '待测试', 'testing', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c3: %v", err)
	}

	return db
}

func TestBatchUpdateTasksHandler(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task2', 'Task 2', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task3', 'Task 3', 'c2', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task3: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/tasks/batch", handlers.BatchUpdateTasks(db))

	t.Run("batch update without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch update with empty ids returns 400", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{}, "columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch update without any update field returns 400", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch update with columnId successfully moves tasks", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1", "task2"}, "columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["updated"].(float64) != 2 {
			t.Errorf("expected updated=2, got %v", response["updated"])
		}

		var col1, col2 string
		db.QueryRow("SELECT column_id FROM tasks WHERE id = 'task1'").Scan(&col1)
		db.QueryRow("SELECT column_id FROM tasks WHERE id = 'task2'").Scan(&col2)
		if col1 != "c2" || col2 != "c2" {
			t.Errorf("expected tasks to be in c2, got task1=%s, task2=%s", col1, col2)
		}
	})

	t.Run("batch update with status successfully moves tasks", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "status": "testing"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var col string
		db.QueryRow("SELECT column_id FROM tasks WHERE id = 'task1'").Scan(&col)
		if col != "c3" {
			t.Errorf("expected task1 to be in c3 (待测试), got %s", col)
		}
	})

	t.Run("batch update with priority successfully updates tasks", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "priority": "high"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var priority string
		db.QueryRow("SELECT priority FROM tasks WHERE id = 'task1'").Scan(&priority)
		if priority != "high" {
			t.Errorf("expected priority=high, got %s", priority)
		}
	})

	t.Run("batch update with assignee successfully updates tasks", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "assignee": "newuser"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var assignee string
		db.QueryRow("SELECT assignee FROM tasks WHERE id = 'task1'").Scan(&assignee)
		if assignee != "newuser" {
			t.Errorf("expected assignee=newuser, got %s", assignee)
		}
	})

	t.Run("batch update with non-existent task reports failed", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"nonexistent"}, "columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response["failed"])
		}
	})
}

func TestBatchUpdateTasksPermissionDenied(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'other_user')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test member user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t2', 'u2', 'member-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test member token: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/tasks/batch", handlers.BatchUpdateTasks(db))

	t.Run("member cannot update tasks they did not create", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "priority": "high"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200 (partial success), got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response["failed"])
		}
	})
}

func TestBatchDeleteTasksHandler(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task2', 'Task 2', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task3', 'Task 3', 'c2', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task3: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/tasks/batch", handlers.BatchDeleteTasks(db))

	t.Run("batch delete without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("DELETE", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch delete with empty ids returns 400", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("DELETE", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch delete successfully deletes tasks", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1", "task2"}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("DELETE", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["deleted"].(float64) != 2 {
			t.Errorf("expected deleted=2, got %v", response["deleted"])
		}

		var count int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id IN ('task1', 'task2')").Scan(&count)
		if count != 0 {
			t.Errorf("expected tasks to be deleted, got count=%d", count)
		}
	})

	t.Run("batch delete with non-existent task reports failed", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"nonexistent"}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("DELETE", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response["failed"])
		}
	})
}

func TestBatchDeleteTasksPermissionDenied(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'other_user')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test member user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t2', 'u2', 'member-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test member token: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/tasks/batch", handlers.BatchDeleteTasks(db))

	t.Run("member cannot delete tasks they did not create", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("DELETE", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200 (partial success), got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response["failed"])
		}
	})
}

func TestBatchCreateTasksHandler(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks/batch", handlers.BatchCreateTasks(db))

	t.Run("batch create without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{
			"tasks": []map[string]interface{}{
				{"title": "New Task", "columnId": "c1"},
			},
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch create with empty tasks returns 400", func(t *testing.T) {
		body := map[string]interface{}{"tasks": []map[string]interface{}{}}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch create successfully creates tasks", func(t *testing.T) {
		body := map[string]interface{}{
			"tasks": []map[string]interface{}{
				{"title": "Batch Task 1", "columnId": "c1", "priority": "high"},
				{"title": "Batch Task 2", "columnId": "c1", "priority": "low"},
			},
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["created"].(float64) != 2 {
			t.Errorf("expected created=2, got %v", response["created"])
		}

		tasks, ok := response["tasks"].([]interface{})
		if !ok || len(tasks) != 2 {
			t.Errorf("expected 2 tasks in response, got %v", response["tasks"])
		}

		var count int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE title LIKE 'Batch Task%'").Scan(&count)
		if count != 2 {
			t.Errorf("expected 2 tasks in DB, got count=%d", count)
		}
	})
}

func TestBatchCreateTasksPermissionDenied(t *testing.T) {
	db := setupBatchTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test member user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t2', 'u2', 'member-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test member token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u2', 'b1', 'READ')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks/batch", handlers.BatchCreateTasks(db))

	t.Run("member with only read access cannot create tasks", func(t *testing.T) {
		body := map[string]interface{}{
			"tasks": []map[string]interface{}{
				{"title": "Should Fail Task", "columnId": "c1"},
			},
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200 (partial success), got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response["failed"])
		}
	})
}

func setupCrossBoardDB(t *testing.T) *sql.DB {
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
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
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
	CREATE TABLE column_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT', 'APP_CONFIG_UPDATE')),
		target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'test-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Test Board 1')`)
	if err != nil {
		t.Fatalf("failed to insert test board 1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b2', 'Test Board 2')`)
	if err != nil {
		t.Fatalf("failed to insert test board 2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u1', 'b2', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c1', '待办', 'todo', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', '待办', 'todo', 'b2')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	return db
}

func TestBatchUpdateTasksCrossBoard(t *testing.T) {
	db := setupCrossBoardDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/tasks/batch", handlers.BatchUpdateTasks(db))

	t.Run("batch update cannot move task to different board", func(t *testing.T) {
		body := map[string]interface{}{"ids": []string{"task1"}, "columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/batch", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["failed"].(float64) != 1 {
			t.Errorf("expected failed=1, got %v", response)
		}
		errors, ok := response["errors"].([]interface{})
		if !ok || len(errors) == 0 {
			t.Errorf("expected error message, got %v", response)
		}
		if len(errors) > 0 && errors[0] != "task task1: cannot move task to a column in a different board" {
			t.Errorf("expected cross-board error, got %v", errors[0])
		}

		var colID string
		db.QueryRow("SELECT column_id FROM tasks WHERE id = 'task1'").Scan(&colID)
		if colID != "c1" {
			t.Errorf("task should remain in c1, got %s", colID)
		}
	})
}
