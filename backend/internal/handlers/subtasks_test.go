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

func setupSubtasksDB(t *testing.T) *sql.DB {
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
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		color TEXT DEFAULT '#6b7280',
		description TEXT DEFAULT '',
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
		UNIQUE(board_id, status)
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
		meta TEXT,
		column_id TEXT NOT NULL,
		board_id TEXT,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 0,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user admin: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user member: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u3', 'viewer', 'viewer', 'pass', 'VIEWER', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user viewer: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'admin-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token t1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t2', 'u2', 'member-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token t2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t3', 'u3', 'viewer-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token t3: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Test Board')`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission admin: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u2', 'b1', 'WRITE')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission member: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp3', 'u3', 'b1', 'READ')`)
	if err != nil {
		t.Fatalf("failed to insert test board permission viewer: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c1', 'Test Column', 'todo', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published) VALUES ('task1', 'Test Task', 'c1', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test task: %v", err)
	}

	return db
}

func TestGetSubtasksHandler(t *testing.T) {
	db := setupSubtasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/subtasks", handlers.GetSubtasks(db))

	t.Run("get subtasks without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=task1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get subtasks for invalid taskId returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=invalid", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get subtasks for task without access returns 403", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b2', 'Private Board')`)
		if err != nil {
			t.Fatalf("failed to insert private board: %v", err)
		}
		_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', 'Private Column', 'todo', 'b2')`)
		if err != nil {
			t.Fatalf("failed to insert private column: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published) VALUES ('task2', 'Private Task', 'c2', 'b2', 1)`)
		if err != nil {
			t.Fatalf("failed to insert private task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=task2", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get subtasks with no subtasks returns empty array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 0 {
			t.Errorf("expected empty array, got %v", resp)
		}
	})

	t.Run("get subtasks with existing subtasks returns subtasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st1', 'Test subtask', 0, 'task1')`)
		if err != nil {
			t.Fatalf("failed to insert test subtask: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 subtask, got %d", len(resp))
		}
	})

	t.Run("get subtasks ordered by created_at ascending", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id, created_at) VALUES ('st2', 'Second subtask', 0, 'task1', datetime('now', '+1 hour'))`)
		if err != nil {
			t.Fatalf("failed to insert test subtask st2: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/subtasks?taskId=task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 2 {
			t.Errorf("expected 2 subtasks, got %d", len(resp))
		}
		if resp[0]["id"] != "st1" || resp[1]["id"] != "st2" {
			t.Errorf("expected subtasks ordered by created_at, got %v", resp)
		}
	})

	t.Run("get all subtasks without taskId filter", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/subtasks", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) < 2 {
			t.Errorf("expected at least 2 subtasks, got %d", len(resp))
		}
	})
}

func TestCreateSubtaskHandler(t *testing.T) {
	db := setupSubtasksDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/subtasks", handlers.CreateSubtask(db))

	t.Run("create subtask without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"title": "New subtask", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("viewer role cannot create subtask returns 403", func(t *testing.T) {
		body := map[string]interface{}{"title": "New subtask", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "viewer-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create subtask without taskId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"title": "New subtask"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create subtask with invalid taskId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"title": "New subtask", "taskId": "invalid"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create subtask with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"title": "New subtask", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["title"] != "New subtask" {
			t.Errorf("expected title 'New subtask', got %v", resp["title"])
		}
		if resp["taskId"] != "task1" {
			t.Errorf("expected taskId 'task1', got %v", resp["taskId"])
		}
		if resp["completed"] != false {
			t.Errorf("expected completed false, got %v", resp["completed"])
		}
		if resp["id"] == "" {
			t.Errorf("expected non-empty id, got %v", resp["id"])
		}
	})

	t.Run("create subtask as member returns 200", func(t *testing.T) {
		body := map[string]interface{}{"title": "Member subtask", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/subtasks", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["title"] != "Member subtask" {
			t.Errorf("expected title 'Member subtask', got %v", resp["title"])
		}
	})
}

func TestUpdateSubtaskHandler(t *testing.T) {
	db := setupSubtasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st1', 'Test subtask', 0, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/subtasks/:id", handlers.UpdateSubtask(db))

	t.Run("update subtask without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"title": "Updated subtask"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/st1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("viewer role cannot update subtask returns 403", func(t *testing.T) {
		body := map[string]interface{}{"title": "Updated subtask"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/st1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "viewer-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update non-existent subtask returns 404", func(t *testing.T) {
		body := map[string]interface{}{"title": "Updated subtask"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/nonexistent", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update subtask title returns 200", func(t *testing.T) {
		body := map[string]interface{}{"title": "Updated subtask"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/st1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["title"] != "Updated subtask" {
			t.Errorf("expected title 'Updated subtask', got %v", resp["title"])
		}
	})

	t.Run("update subtask completed status returns 200", func(t *testing.T) {
		completed := true
		body := map[string]interface{}{"completed": completed}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/st1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["completed"] != true {
			t.Errorf("expected completed true, got %v", resp["completed"])
		}
	})

	t.Run("update subtask as member returns 200", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st2', 'Member subtask', 0, 'task1')`)
		if err != nil {
			t.Fatalf("failed to insert test subtask st2: %v", err)
		}

		body := map[string]interface{}{"title": "Updated by member"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/subtasks/st2", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["title"] != "Updated by member" {
			t.Errorf("expected title 'Updated by member', got %v", resp["title"])
		}
	})
}

func TestDeleteSubtaskHandler(t *testing.T) {
	db := setupSubtasksDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st1', 'Test subtask', 0, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/subtasks/:id", handlers.DeleteSubtask(db))

	t.Run("delete subtask without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/subtasks/st1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("viewer role cannot delete subtask returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/subtasks/st1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "viewer-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete non-existent subtask returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/subtasks/nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete subtask with valid auth returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/subtasks/st1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["success"] != true {
			t.Errorf("expected success true, got %v", resp["success"])
		}
	})

	t.Run("delete subtask as member returns 200", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('st2', 'Member subtask', 0, 'task1')`)
		if err != nil {
			t.Fatalf("failed to insert test subtask st2: %v", err)
		}

		req, _ := http.NewRequest("DELETE", "/api/subtasks/st2", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}
