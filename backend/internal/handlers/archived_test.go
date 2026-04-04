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

func setupArchivedDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
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
		position INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
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
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b2', 'Other Board')`)
	if err != nil {
		t.Fatalf("failed to insert test board b2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c1', 'Test Column', 'todo', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', 'Other Column', 'todo', 'b2')`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}

	return db
}

func TestGetArchivedTasksHandler(t *testing.T) {
	db := setupArchivedDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/archived", handlers.GetArchivedTasks(db))

	t.Run("get archived tasks without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/archived", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get archived tasks with no archived tasks returns empty array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/archived", nil)
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

	t.Run("get archived tasks returns archived tasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived, archived_at) VALUES ('task1', 'Archived Task', 'c1', 'b1', 1, 1, datetime('now'))`)
		if err != nil {
			t.Fatalf("failed to insert archived task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/archived", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 archived task, got %d", len(resp))
		}
		if resp[0]["id"] != "task1" {
			t.Errorf("expected task id 'task1', got %v", resp[0]["id"])
		}
		if resp[0]["archived"] != true {
			t.Errorf("expected archived=true, got %v", resp[0]["archived"])
		}
	})

	t.Run("get archived tasks filtered by boardId", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived, archived_at) VALUES ('task2', 'Archived Task B2', 'c2', 'b2', 1, 1, datetime('now'))`)
		if err != nil {
			t.Fatalf("failed to insert archived task for b2: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/archived?boardId=b1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 archived task for b1, got %d", len(resp))
		}
		if resp[0]["id"] != "task1" {
			t.Errorf("expected task id 'task1', got %v", resp[0]["id"])
		}
	})

	t.Run("get archived tasks excludes non-archived tasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('task3', 'Active Task', 'c1', 'b1', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert active task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/archived", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 2 {
			t.Errorf("expected 2 archived tasks, got %d", len(resp))
		}
		for _, task := range resp {
			if task["archived"] != true {
				t.Errorf("expected all tasks to be archived, got %v", task["archived"])
			}
		}
	})

	t.Run("get archived tasks excludes drafts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('task4', 'Draft Task', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/archived", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		for _, task := range resp {
			if task["published"] == false {
				t.Errorf("expected no drafts in archived tasks, got %v", task)
			}
		}
	})
}

func TestGetDraftsHandler(t *testing.T) {
	db := setupArchivedDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/drafts", handlers.GetDrafts(db))

	t.Run("get drafts without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/drafts", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get drafts with no drafts returns empty array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/drafts", nil)
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

	t.Run("get drafts returns draft tasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('draft1', 'Draft Task', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/drafts", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 draft task, got %d", len(resp))
		}
		if resp[0]["id"] != "draft1" {
			t.Errorf("expected task id 'draft1', got %v", resp[0]["id"])
		}
		if resp[0]["published"] != false {
			t.Errorf("expected published=false, got %v", resp[0]["published"])
		}
	})

	t.Run("get drafts filtered by boardId", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('draft2', 'Draft Task B2', 'c2', 'b2', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task for b2: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/drafts?boardId=b1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 draft task for b1, got %d", len(resp))
		}
		if resp[0]["id"] != "draft1" {
			t.Errorf("expected task id 'draft1', got %v", resp[0]["id"])
		}
	})

	t.Run("get drafts excludes published tasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('pub1', 'Published Task', 'c1', 'b1', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert published task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/drafts", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		for _, task := range resp {
			if task["published"] == true {
				t.Errorf("expected no published tasks in drafts, got %v", task)
			}
		}
	})

	t.Run("get drafts excludes archived tasks", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('archived1', 'Archived Draft', 'c1', 'b1', 0, 1)`)
		if err != nil {
			t.Fatalf("failed to insert archived draft task: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/drafts", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		for _, task := range resp {
			if task["archived"] == true {
				t.Errorf("expected no archived tasks in drafts, got %v", task)
			}
		}
	})
}

func TestBatchDeleteDraftsHandler(t *testing.T) {
	db := setupArchivedDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/drafts/batch", handlers.BatchDeleteDrafts(db))

	t.Run("batch delete without auth returns 401", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": ["d1", "d2"]}`)
		req, _ := http.NewRequest("DELETE", "/api/drafts/batch", body)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch delete with empty ids returns 400", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": []}`)
		req, _ := http.NewRequest("DELETE", "/api/drafts/batch", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch delete without body returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/drafts/batch", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch delete successfully deletes drafts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('d1', 'Draft 1', 'c1', 'b1', 0, 0), ('d2', 'Draft 2', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft tasks: %v", err)
		}

		body := bytes.NewBufferString(`{"ids": ["d1", "d2"]}`)
		req, _ := http.NewRequest("DELETE", "/api/drafts/batch", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]int
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["deleted"] != 2 {
			t.Errorf("expected deleted=2, got %v", resp)
		}

		var count int
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE id IN ('d1', 'd2')`).Scan(&count)
		if count != 0 {
			t.Errorf("expected 0 remaining drafts, got %d", count)
		}
	})

	t.Run("batch delete only affects drafts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('pub1', 'Published', 'c1', 'b1', 1, 0)`)
		if err != nil {
			t.Fatalf("failed to insert published task: %v", err)
		}

		body := bytes.NewBufferString(`{"ids": ["pub1"]}`)
		req, _ := http.NewRequest("DELETE", "/api/drafts/batch", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]int
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["deleted"] != 0 {
			t.Errorf("expected deleted=0 for published task, got %v", resp)
		}
	})
}

func TestBatchPublishDraftsHandler(t *testing.T) {
	db := setupArchivedDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/drafts/batch/publish", handlers.BatchPublishDrafts(db))

	t.Run("batch publish without auth returns 401", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": ["d1"], "columnId": "c1"}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/publish", body)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch publish with empty ids returns 400", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": [], "columnId": "c1"}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/publish", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch publish without columnId returns 400", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": ["d1"]}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/publish", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch publish successfully publishes drafts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('d1', 'Draft 1', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task d1: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('d2', 'Draft 2', 'c2', 'b2', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task d2: %v", err)
		}

		body := bytes.NewBufferString(`{"ids": ["d1", "d2"], "columnId": "c1"}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/publish", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]int
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["published"] != 2 {
			t.Errorf("expected published=2, got %v", resp)
		}
	})
}

func TestBatchArchiveDraftsHandler(t *testing.T) {
	db := setupArchivedDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/drafts/batch/archive", handlers.BatchArchiveDrafts(db))

	t.Run("batch archive without auth returns 401", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": ["d1"]}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/archive", body)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch archive with empty ids returns 400", func(t *testing.T) {
		body := bytes.NewBufferString(`{"ids": []}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/archive", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("batch archive successfully archives drafts", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('d1', 'Draft 1', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task d1: %v", err)
		}
		_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, board_id, published, archived) VALUES ('d2', 'Draft 2', 'c1', 'b1', 0, 0)`)
		if err != nil {
			t.Fatalf("failed to insert draft task d2: %v", err)
		}

		body := bytes.NewBufferString(`{"ids": ["d1", "d2"]}`)
		req, _ := http.NewRequest("PUT", "/api/drafts/batch/archive", body)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]int
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["archived"] != 2 {
			t.Errorf("expected archived=2, got %v", resp)
		}
	})
}
