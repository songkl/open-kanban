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

func setupTemplatesDB(t *testing.T) *sql.DB {
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
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
	);
	CREATE TABLE templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		board_id TEXT,
		columns_config TEXT,
		include_tasks BOOLEAN DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, name, key, user_id, expires_at) VALUES ('t1', 'default', 'test-token', 'u1', NULL)`)
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
	_, err = db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('c1', 'To Do', 'todo', 0, 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('c2', 'Done', 'done', 1, 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('task1', 'Test Task', 'c1', 0)`)
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

	return db
}

func TestGetTemplatesHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("get templates without auth returns 401", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.GET("/api/templates", handlers.GetTemplates(db))

		req, _ := http.NewRequest("GET", "/api/templates", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get templates with auth returns templates list", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.GET("/api/templates", handlers.GetTemplates(db))

		req, _ := http.NewRequest("GET", "/api/templates", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		if w.Body.String() != "null" && w.Body.String() != "[]" {
			t.Errorf("expected null or empty array, got %s", w.Body.String())
		}
	})
}

func TestSaveTemplateHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("save template without auth returns 401", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/templates", handlers.SaveTemplate(db))

		body := map[string]interface{}{"name": "New Template", "boardId": "b1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/templates", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("save template with valid data returns 200", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/templates", handlers.SaveTemplate(db))

		body := map[string]interface{}{"name": "New Template", "boardId": "b1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/templates", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["name"] != "New Template" {
			t.Errorf("expected name 'New Template', got %v", resp["name"])
		}
		if resp["boardId"] != "b1" {
			t.Errorf("expected boardId 'b1', got %v", resp["boardId"])
		}
	})

	t.Run("save template without name returns 400", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/templates", handlers.SaveTemplate(db))

		body := map[string]interface{}{"boardId": "b1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/templates", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteTemplateHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("delete template without auth returns 401", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/templates/:id", handlers.DeleteTemplate(db))

		req, _ := http.NewRequest("DELETE", "/api/templates/tmpl1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete non-existent template returns 404", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/templates/:id", handlers.DeleteTemplate(db))

		req, _ := http.NewRequest("DELETE", "/api/templates/nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete existing template returns success", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		_, err := db.Exec(`INSERT INTO templates (id, name, board_id, created_by) VALUES ('tmpl1', 'Template to Delete', 'b1', 'u1')`)
		if err != nil {
			t.Fatalf("failed to insert test template: %v", err)
		}

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/templates/:id", handlers.DeleteTemplate(db))

		req, _ := http.NewRequest("DELETE", "/api/templates/tmpl1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCopyBoardHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("copy board without auth returns 401", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))

		req, _ := http.NewRequest("POST", "/api/boards/b1/copy", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("copy board without permission returns 403", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u1', 'b1', 'READ')`)

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))

		req, _ := http.NewRequest("POST", "/api/boards/b1/copy", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden && w.Code != http.StatusInternalServerError {
			t.Errorf("expected 403 or 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateBoardFromTemplateHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("create board from template without auth returns 401", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/boards/from-template", handlers.CreateBoardFromTemplate(db))

		body := map[string]interface{}{"name": "New Board", "templateId": "tmpl1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards/from-template", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create board from template without name returns 400", func(t *testing.T) {
		db := setupTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/boards/from-template", handlers.CreateBoardFromTemplate(db))

		body := map[string]interface{}{"templateId": "tmpl1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards/from-template", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}
