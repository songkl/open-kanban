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

func setupCommentsDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		nickname TEXT UNIQUE NOT NULL,
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
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
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
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, nickname, password, role, enabled, avatar, type) VALUES ('u1', 'admin', 'pass', 'ADMIN', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user admin: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, nickname, password, role, enabled, avatar, type) VALUES ('u2', 'member', 'pass', 'MEMBER', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user member: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, nickname, password, role, enabled, avatar, type) VALUES ('u3', 'viewer', 'pass', 'VIEWER', 1, '', 'HUMAN')`)
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

func TestGetCommentsHandler(t *testing.T) {
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/comments", handlers.GetComments(db))

	t.Run("get comments without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments?taskId=task1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get comments without taskId returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get comments for invalid taskId returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments?taskId=invalid", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get comments with no comments returns empty array", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments?taskId=task1", nil)
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

	t.Run("get comments with existing comments returns comments", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO comments (id, content, author, task_id, user_id) VALUES ('c1', 'Test comment', 'admin', 'task1', 'u1')`)
		if err != nil {
			t.Fatalf("failed to insert test comment: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/comments?taskId=task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 comment, got %d", len(resp))
		}
	})

	t.Run("get comments ordered by created_at ascending", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO comments (id, content, author, task_id, user_id, created_at) VALUES ('c2', 'Second comment', 'admin', 'task1', 'u1', datetime('now', '+1 hour'))`)
		if err != nil {
			t.Fatalf("failed to insert test comment c2: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/comments?taskId=task1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 2 {
			t.Errorf("expected 2 comments, got %d", len(resp))
		}
		if resp[0]["id"] != "c1" || resp[1]["id"] != "c2" {
			t.Errorf("expected comments ordered by created_at, got %v", resp)
		}
	})
}

func TestGetCommentHandler(t *testing.T) {
	db := setupCommentsDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO comments (id, content, author, task_id, user_id) VALUES ('c1', 'Test comment', 'admin', 'task1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test comment: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/comments/:id", handlers.GetComment(db))

	t.Run("get comment without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments/c1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get non-existent comment returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments/nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get comment with valid auth returns comment", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/comments/c1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["id"] != "c1" {
			t.Errorf("expected comment id c1, got %v", resp["id"])
		}
		if resp["content"] != "Test comment" {
			t.Errorf("expected content 'Test comment', got %v", resp["content"])
		}
		if resp["author"] != "admin" {
			t.Errorf("expected author 'admin', got %v", resp["author"])
		}
		if resp["taskId"] != "task1" {
			t.Errorf("expected taskId 'task1', got %v", resp["taskId"])
		}
	})
}

func TestCreateCommentHandler(t *testing.T) {
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	t.Run("create comment without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"content": "Test comment", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("viewer role cannot create comment returns 403", func(t *testing.T) {
		body := map[string]interface{}{"content": "Test comment", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "viewer-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create comment without taskId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"content": "Test comment"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create comment with invalid taskId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"content": "Test comment", "taskId": "invalid"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create comment with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"content": "Test comment", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["content"] != "Test comment" {
			t.Errorf("expected content 'Test comment', got %v", resp["content"])
		}
		if resp["author"] != "admin" {
			t.Errorf("expected author 'admin', got %v", resp["author"])
		}
		if resp["taskId"] != "task1" {
			t.Errorf("expected taskId 'task1', got %v", resp["taskId"])
		}
		if resp["id"] == "" {
			t.Errorf("expected non-empty id, got %v", resp["id"])
		}
	})

	t.Run("create comment as member returns 200", func(t *testing.T) {
		body := map[string]interface{}{"content": "Member comment", "taskId": "task1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["content"] != "Member comment" {
			t.Errorf("expected content 'Member comment', got %v", resp["content"])
		}
		if resp["author"] != "member" {
			t.Errorf("expected author 'member', got %v", resp["author"])
		}
	})
}
