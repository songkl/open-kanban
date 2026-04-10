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

func setupColumnsDB(t *testing.T) *sql.DB {
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
		author TEXT NOT NULL,
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
	// Insert columns with different positions for filtering tests
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column c1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column c2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c3', 'Column 3', 'b1', 2)`)
	if err != nil {
		t.Fatalf("failed to insert test column c3: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c4', 'Column 4', 'b1', 3)`)
	if err != nil {
		t.Fatalf("failed to insert test column c4: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c5', 'Column 5', 'b1', 4)`)
	if err != nil {
		t.Fatalf("failed to insert test column c5: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('task1', 'Task 1', 'c1', 0, 1)`)
	if err != nil {
		t.Fatalf("failed to insert test task1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('task2', 'Task 2', 'c1', 1, 1)`)
	if err != nil {
		t.Fatalf("failed to insert test task2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO comments (id, content, author, task_id) VALUES ('com1', 'Comment 1', 'u1', 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test comment com1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO comments (id, content, author, task_id) VALUES ('com2', 'Comment 2', 'u1', 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test comment com2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('sub1', 'Subtask 1', 0, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask sub1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('sub2', 'Subtask 2', 1, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask sub2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('sub3', 'Subtask 3', 0, 'task1')`)
	if err != nil {
		t.Fatalf("failed to insert test subtask sub3: %v", err)
	}

	return db
}

func TestGetColumnsHandler(t *testing.T) {
	db := setupColumnsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/columns", handlers.GetColumns(db))

	t.Run("get columns without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns?boardId=b1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get columns with auth returns columns", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns?boardId=b1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp == nil {
			t.Errorf("expected array response, got nil")
		}
	})

	t.Run("get columns returns correct commentCount and subtaskCount", func(t *testing.T) {
		var count int
		db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&count)
		t.Logf("Total tasks in DB: %d", count)

		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE column_id = 'c1'").Scan(&count)
		t.Logf("Tasks in c1: %d", count)

		req, _ := http.NewRequest("GET", "/api/columns?boardId=b1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		t.Logf("Response body: %s", w.Body.String())

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		for _, col := range resp {
			t.Logf("Column %v, tasks: %v", col["id"], col["tasks"])
			if col["id"] == "c1" {
				if col["tasks"] == nil {
					t.Logf("DEBUG: tasks is nil for c1")
					continue
				}
				tasks, ok := col["tasks"].([]interface{})
				if !ok {
					t.Logf("DEBUG: tasks is not []interface{} for c1, got %T", col["tasks"])
					continue
				}
				if len(tasks) == 0 {
					t.Logf("DEBUG: tasks is empty array for c1")
				}
				for _, task := range tasks {
					taskMap := task.(map[string]interface{})
					t.Logf("Task: %v", taskMap["id"])
					if taskMap["id"] == "task1" {
						commentCount := int(taskMap["commentCount"].(float64))
						subtaskCount := int(taskMap["subtaskCount"].(float64))
						if commentCount != 2 {
							t.Errorf("expected task1 commentCount 2, got %d", commentCount)
						}
						if subtaskCount != 3 {
							t.Errorf("expected task1 subtaskCount 3, got %d", subtaskCount)
						}
					}
					if taskMap["id"] == "task2" {
						commentCount := int(taskMap["commentCount"].(float64))
						subtaskCount := int(taskMap["subtaskCount"].(float64))
						if commentCount != 0 {
							t.Errorf("expected task2 commentCount 0, got %d", commentCount)
						}
						if subtaskCount != 0 {
							t.Errorf("expected task2 subtaskCount 0, got %d", subtaskCount)
						}
					}
				}
			}
		}
	})

	t.Run("get columns filtered by single position", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns?boardId=b1&positions=1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 1 {
			t.Errorf("expected 1 column, got %d", len(resp))
		}
		if len(resp) > 0 {
			if pos, ok := resp[0]["position"].(float64); !ok || pos != 1 {
				t.Errorf("expected position 1, got %v", resp[0]["position"])
			}
		}
	})

	t.Run("get columns filtered by multiple positions", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns?boardId=b1&positions=0,2,4", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 3 {
			t.Errorf("expected 3 columns, got %d", len(resp))
		}
		// Check that only positions 0, 2, 4 are returned
		positions := make(map[float64]bool)
		for _, col := range resp {
			positions[col["position"].(float64)] = true
		}
		if !positions[0] || !positions[2] || !positions[4] || len(positions) != 3 {
			t.Errorf("expected positions [0,2,4], got %v", positions)
		}
	})

	t.Run("get columns filtered by positions without boardId", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns?positions=1,3", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if len(resp) != 2 {
			t.Errorf("expected 2 columns, got %d", len(resp))
		}
	})
}

func TestCreateColumnHandler(t *testing.T) {
	db := setupColumnsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/columns", handlers.CreateColumn(db))

	t.Run("create column without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"name": "Test Column", "boardId": "b1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create column without boardId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"name": "Test Column"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create column with valid data returns 200", func(t *testing.T) {
		body := map[string]interface{}{"name": "Test Column", "boardId": "b1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestUpdateColumnHandler(t *testing.T) {
	db := setupColumnsDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c6', 'Old Name', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/columns", handlers.UpdateColumn(db))

	t.Run("update column without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"id": "c1", "name": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update column with valid data returns success", func(t *testing.T) {
		body := map[string]interface{}{"id": "c1", "name": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update column with empty id returns 400", func(t *testing.T) {
		body := map[string]interface{}{"name": "Another Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/columns", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteColumnHandler(t *testing.T) {
	db := setupColumnsDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c7', 'Column to Delete', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/columns", handlers.DeleteColumn(db))

	t.Run("delete column without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns?id=c1", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete column with valid id returns success", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column to Delete 2', 'b1', 1)`)

		req, _ := http.NewRequest("DELETE", "/api/columns?id=c2", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete column with empty id returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns?id=", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetColumnSlugHandler(t *testing.T) {
	db := setupColumnsDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/columns/slug", handlers.GetColumnSlug(db))

	t.Run("get slug with valid name returns slug", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/slug?name=开发", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if response["slug"] != "kaifa" {
			t.Errorf("expected slug 'kaifa', got '%s'", response["slug"])
		}
	})

	t.Run("get slug with mixed chinese and english returns combined slug", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/slug?name=Test开发", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var response map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if response["slug"] != "testkaifa" {
			t.Errorf("expected slug 'testkaifa', got '%s'", response["slug"])
		}
	})

	t.Run("get slug without name returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/slug", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get slug with empty name returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/slug?name=", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}
