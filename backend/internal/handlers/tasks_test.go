package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupTasksDB(t *testing.T) *sql.DB {
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
		action TEXT NOT NULL,
		target_type TEXT,
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id) VALUES ('c1', 'Test Column', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	return db
}

func TestGetTasksHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/tasks", handlers.GetTasks(db))

	t.Run("get tasks without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get tasks with auth returns tasks list", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateTaskHandler(t *testing.T) {
	handlers.ResetRateLimitMapForTest()
	handlers.ResetTokenCacheForTest()
	db := setupTasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks", handlers.CreateTask(db))

	t.Run("create task without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"title": "Test Task", "columnId": "c1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create task without columnId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"title": "Test Task"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create task with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"title": "Test Task", "columnId": "c1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateTaskHandlerWithPriority(t *testing.T) {
	handlers.ResetRateLimitMapForTest()
	handlers.ResetGlobalRateLimitMapForTest()
	handlers.ResetTokenCacheForTest()
	db := setupTasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks", handlers.CreateTask(db))

	t.Run("high priority first task gets position 1000", func(t *testing.T) {
		body := map[string]interface{}{"title": "High Priority Task", "columnId": "c1", "priority": "high"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			return
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if int(resp["position"].(float64)) != 1000 {
			t.Errorf("expected position 1000, got %v", resp["position"])
		}
	})

	t.Run("high priority second task gets position 2000", func(t *testing.T) {
		time.Sleep(100 * time.Millisecond)
		body := map[string]interface{}{"title": "High Priority Task 2", "columnId": "c1", "priority": "high"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			return
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if int(resp["position"].(float64)) != 2000 {
			t.Errorf("expected position 2000, got %v", resp["position"])
		}
	})

	t.Run("low priority task gets MAX position + 1", func(t *testing.T) {
		time.Sleep(100 * time.Millisecond)
		body := map[string]interface{}{"title": "Low Priority Task", "columnId": "c1", "priority": "low"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			return
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if int(resp["position"].(float64)) != 2001 {
			t.Errorf("expected position 2001 (MAX 2000 + 1), got %v", resp["position"])
		}
	})

	t.Run("medium priority task between high and low", func(t *testing.T) {
		time.Sleep(100 * time.Millisecond)
		body := map[string]interface{}{"title": "Medium Priority Task", "columnId": "c1", "priority": "medium"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			return
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if int(resp["position"].(float64)) != 2000 {
			t.Errorf("expected position 2000 ((2000+2001)/2), got %v", resp["position"])
		}
	})

	t.Run("explicit position is used when provided", func(t *testing.T) {
		time.Sleep(100 * time.Millisecond)
		body := map[string]interface{}{"title": "Task with explicit position", "columnId": "c1", "position": 500}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
			return
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if int(resp["position"].(float64)) != 500 {
			t.Errorf("expected position 500, got %v", resp["position"])
		}
	})
}

func TestDeleteTaskHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('task1', 'Task to Delete', 'c1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/tasks/:id", handlers.DeleteTask(db))

	t.Run("delete task without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/tasks/task1", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete task with auth returns success", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/tasks/task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete non-existent task returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/tasks/nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestUpdateTaskHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Original Title', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/tasks/:id", handlers.UpdateTask(db))

	t.Run("update task without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"title": "New Title"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/task1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update task with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"title": "New Title"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/task1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update non-existent task returns 404", func(t *testing.T) {
		body := map[string]interface{}{"title": "New Title"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/nonexistent", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update task columnId succeeds with non-UUID column ID", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "c2"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/tasks/task1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["columnId"] != "c2" {
			t.Errorf("expected columnId to be c2, got %v", response["columnId"])
		}
	})
}

func TestArchiveTaskHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task to Archive', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks/:id/archive", handlers.ArchiveTask(db))

	t.Run("archive task without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"archived": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/task1/archive", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("archive task with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"archived": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/task1/archive", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("unarchive task returns 200", func(t *testing.T) {
		body := map[string]interface{}{"archived": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/task1/archive", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("archive non-existent task returns 404", func(t *testing.T) {
		body := map[string]interface{}{"archived": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/tasks/nonexistent/archive", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCompleteTaskHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Next Column', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by, updated_at) VALUES ('task1', 'Task to Complete', 'c1', 'u1', datetime('now'))`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/tasks/:id/complete", handlers.CompleteTask(db))

	t.Run("complete task without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/tasks/task1/complete", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("complete task with valid data returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/tasks/task1/complete", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("complete non-existent task returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/tasks/nonexistent/complete", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetTaskHandler(t *testing.T) {
	db := setupTasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Test Task', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}
	_, err = db.Exec(`INSERT INTO comments (id, content, author, task_id) VALUES ('cm1', 'Test Comment', 'admin', 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test comment: %v", err)
	}
	_, err = db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st1', 'Test Subtask', 0, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/tasks/:id", handlers.GetTask(db))

	t.Run("get task without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/task1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get non-existent task returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get task without include returns counts only", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)

		if response["commentCount"] != float64(1) {
			t.Errorf("expected commentCount 1, got %v", response["commentCount"])
		}
		if response["subtaskCount"] != float64(1) {
			t.Errorf("expected subtaskCount 1, got %v", response["subtaskCount"])
		}
		if response["comments"] != nil {
			t.Errorf("expected no comments field, got %v", response["comments"])
		}
		if response["subtasks"] != nil {
			t.Errorf("expected no subtasks field, got %v", response["subtasks"])
		}
	})

	t.Run("get task with include=comments returns full comments array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/task1?include=comments", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)

		if response["commentCount"] != float64(1) {
			t.Errorf("expected commentCount 1, got %v", response["commentCount"])
		}
		comments, ok := response["comments"].([]interface{})
		if !ok {
			t.Errorf("expected comments to be array, got %v", response["comments"])
		}
		if len(comments) != 1 {
			t.Errorf("expected 1 comment, got %d", len(comments))
		}
	})

	t.Run("get task with include=subtasks returns full subtasks array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/task1?include=subtasks", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)

		if response["subtaskCount"] != float64(1) {
			t.Errorf("expected subtaskCount 1, got %v", response["subtaskCount"])
		}
		subtasks, ok := response["subtasks"].([]interface{})
		if !ok {
			t.Errorf("expected subtasks to be array, got %v", response["subtasks"])
		}
		if len(subtasks) != 1 {
			t.Errorf("expected 1 subtask, got %d", len(subtasks))
		}
	})

	t.Run("get task with include=comments,subtasks returns both arrays", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/tasks/task1?include=comments,subtasks", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &response)

		comments, _ := response["comments"].([]interface{})
		if len(comments) != 1 {
			t.Errorf("expected 1 comment, got %d", len(comments))
		}
		subtasks, _ := response["subtasks"].([]interface{})
		if len(subtasks) != 1 {
			t.Errorf("expected 1 subtask, got %d", len(subtasks))
		}
	})
}
