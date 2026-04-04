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

func setupBoardsDB(t *testing.T) *sql.DB {
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
	CREATE TABLE column_agents (
		id TEXT PRIMARY KEY,
		column_id TEXT UNIQUE NOT NULL,
		agent_types TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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

	return db
}

func TestGetBoardsHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b1', 'Test Board', 'A test board')`)
	_, _ = db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b2', 'Another Board', 'Another desc')`)

	router := gin.New()
	router.GET("/api/boards", handlers.GetBoards(db))

	t.Run("get boards is public", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
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
		if len(resp) != 2 {
			t.Errorf("expected 2 boards, got %d", len(resp))
		}
	})

	t.Run("get boards returns correct board data", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		found := false
		for _, board := range resp {
			if board["id"] == "b1" && board["name"] == "Test Board" {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected to find board b1 in response")
		}
	})

	t.Run("get boards excludes deleted boards", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('b3', 'Deleted Board', 1)`)

		req, _ := http.NewRequest("GET", "/api/boards", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp []map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		for _, board := range resp {
			if board["id"] == "b3" {
				t.Errorf("deleted board should not be in response")
			}
		}
	})
}

func TestGetBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO boards (id, name, description, short_alias) VALUES ('b1', 'Test Board', 'A test board', 'test')`)
	_, _ = db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b2', 'Another Board', 'Another desc')`)

	router := gin.New()
	router.GET("/api/boards/:id", handlers.GetBoard(db))

	t.Run("get single board by id returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/b1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["id"] != "b1" {
			t.Errorf("expected board id 'b1', got %v", resp["id"])
		}
		if resp["name"] != "Test Board" {
			t.Errorf("expected name 'Test Board', got %v", resp["name"])
		}
		if resp["shortAlias"] != "test" {
			t.Errorf("expected shortAlias 'test', got %v", resp["shortAlias"])
		}
	})

	t.Run("get board not found returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/nonexistent", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get board excludes deleted boards", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('b3', 'Deleted Board', 1)`)

		req, _ := http.NewRequest("GET", "/api/boards/b3", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for deleted board, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards", handlers.CreateBoard(db))

	t.Run("create without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"name": "Test Board"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create with auth and empty body returns 400", func(t *testing.T) {
		body := map[string]interface{}{}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create with valid name returns 200 and creates board", func(t *testing.T) {
		body := map[string]interface{}{"name": "New Test Board", "description": "Test description"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["name"] != "New Test Board" {
			t.Errorf("expected board name 'New Test Board', got %v", resp["name"])
		}
		if resp["description"] != "Test description" {
			t.Errorf("expected description 'Test description', got %v", resp["description"])
		}
	})

	t.Run("create board generates default columns", func(t *testing.T) {
		body := map[string]interface{}{"name": "Board With Columns"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		boardID := resp["id"].(string)

		var colCount int
		db.QueryRow("SELECT COUNT(*) FROM columns WHERE board_id = ?", boardID).Scan(&colCount)
		if colCount != 5 {
			t.Errorf("expected 5 default columns, got %d", colCount)
		}

		var colNames []string
		rows, _ := db.Query("SELECT name FROM columns WHERE board_id = ? ORDER BY position", boardID)
		for rows.Next() {
			var name string
			rows.Scan(&name)
			colNames = append(colNames, name)
		}
		rows.Close()

		expectedCols := []string{"待办", "进行中", "待测试", "待审核", "已完成"}
		for i, expected := range expectedCols {
			if colNames[i] != expected {
				t.Errorf("expected column %d to be '%s', got '%s'", i, expected, colNames[i])
			}
		}
	})

	t.Run("create board with custom id returns board with that id", func(t *testing.T) {
		body := map[string]interface{}{"name": "Custom ID Board", "id": "custom-board-123"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["id"] != "custom-board-123" {
			t.Errorf("expected board id 'custom-board-123', got %v", resp["id"])
		}
	})
}

func TestUpdateBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b1', 'Old Name', 'Old Description')`)
	_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/boards/:id", handlers.UpdateBoard(db))

	t.Run("update without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"name": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update with auth returns 200 and updates board", func(t *testing.T) {
		body := map[string]interface{}{"name": "New Name", "description": "New Description"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["name"] != "New Name" {
			t.Errorf("expected name 'New Name', got %v", resp["name"])
		}
		if resp["description"] != "New Description" {
			t.Errorf("expected description 'New Description', got %v", resp["description"])
		}

		var dbName, dbDesc string
		db.QueryRow("SELECT name, description FROM boards WHERE id = 'b1'").Scan(&dbName, &dbDesc)
		if dbName != "New Name" || dbDesc != "New Description" {
			t.Errorf("board not updated in database")
		}
	})

	t.Run("update with name and description returns success", func(t *testing.T) {
		body := map[string]interface{}{"name": "Updated Name", "description": "Updated Description"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["name"] != "Updated Name" {
			t.Errorf("expected name 'Updated Name', got %v", resp["name"])
		}
	})
}

func TestDeleteBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Board to Delete')`)
	_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/boards/:id", handlers.DeleteBoard(db))

	t.Run("delete without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/boards/b1", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete with auth returns 200 and soft deletes board", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('b2', 'Board To Soft Delete', 0)`)
		_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u1', 'b2', 'ADMIN')`)

		req, _ := http.NewRequest("DELETE", "/api/boards/b2", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var deleted bool
		db.QueryRow("SELECT deleted FROM boards WHERE id = 'b2'").Scan(&deleted)
		if !deleted {
			t.Errorf("expected board to be soft deleted (deleted=1)")
		}
	})

	t.Run("delete existing board returns success", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('b4', 'Another Board To Delete', 0)`)
		_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp4', 'u1', 'b4', 'ADMIN')`)

		req, _ := http.NewRequest("DELETE", "/api/boards/b4", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["success"] != true {
			t.Errorf("expected success=true, got %v", resp["success"])
		}
	})
}

func TestResetBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Board to Reset')`)
	_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'WRITE')`)
	_, _ = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	_, _ = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t1', 'Task 1', 'c1', 0)`)
	_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('t2', 'Task 2', 'c1', 1)`)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards/:id/reset", handlers.ResetBoard(db))

	t.Run("reset without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/boards/b1/reset", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("reset with auth returns 200 and clears board data", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/boards/b1/reset", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["id"] != "b1" {
			t.Errorf("expected board id b1, got %v", resp["id"])
		}

		var colCount int
		db.QueryRow("SELECT COUNT(*) FROM columns WHERE board_id = 'b1'").Scan(&colCount)
		if colCount != 0 {
			t.Errorf("expected 0 columns after reset, got %d", colCount)
		}

		var taskCount int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = 'b1')").Scan(&taskCount)
		if taskCount != 0 {
			t.Errorf("expected 0 tasks after reset, got %d", taskCount)
		}

		var boardExists bool
		db.QueryRow("SELECT EXISTS(SELECT 1 FROM boards WHERE id = 'b1' AND deleted = false)").Scan(&boardExists)
		if !boardExists {
			t.Errorf("board should still exist after reset")
		}
	})

	t.Run("reset non-existent board returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/boards/nonexistent/reset", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("reset without permission returns 403", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '', 'HUMAN')`)
		_, _ = db.Exec(`INSERT INTO tokens (id, name, key, user_id, expires_at) VALUES ('t2', 'default', 'member-token', 'u2', NULL)`)
		_, _ = db.Exec(`INSERT INTO boards (id, name) VALUES ('b2', 'Board No Access')`)
		_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'u2', 'b2', 'READ')`)

		req, _ := http.NewRequest("POST", "/api/boards/b2/reset", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestImportBoardHandler(t *testing.T) {
	db := setupBoardsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards/import", handlers.ImportBoard(db))

	importData := map[string]interface{}{
		"boardName": "Imported Board",
		"columns": []map[string]interface{}{
			{
				"id":       "col1",
				"name":     "To Do",
				"status":   "todo",
				"position": 0,
				"color":    "#ef4444",
				"tasks": []map[string]interface{}{
					{
						"id":        "task1",
						"title":     "Regular Task",
						"published": true,
						"archived":  false,
					},
					{
						"id":        "task2",
						"title":     "Archived Task",
						"published": true,
						"archived":  true,
					},
				},
			},
		},
	}

	t.Run("import without auth returns 401", func(t *testing.T) {
		body, _ := json.Marshal(map[string]interface{}{"data": importData})
		req, _ := http.NewRequest("POST", "/api/boards/import", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("import new board returns 200 and preserves archived status", func(t *testing.T) {
		body, _ := json.Marshal(map[string]interface{}{"data": importData})
		req, _ := http.NewRequest("POST", "/api/boards/import", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["name"] != "Imported Board" {
			t.Errorf("expected board name 'Imported Board', got %v", resp["name"])
		}

		var regularArchived bool
		var archivedTaskArchived bool

		var regularTaskID string
		db.QueryRow("SELECT id FROM tasks WHERE title = 'Regular Task'").Scan(&regularTaskID)
		db.QueryRow("SELECT archived FROM tasks WHERE id = ?", regularTaskID).Scan(&regularArchived)

		var archivedTaskID string
		db.QueryRow("SELECT id FROM tasks WHERE title = 'Archived Task'").Scan(&archivedTaskID)
		db.QueryRow("SELECT archived FROM tasks WHERE id = ?", archivedTaskID).Scan(&archivedTaskArchived)

		if regularArchived != false {
			t.Errorf("expected regular task archived=false, got %v", regularArchived)
		}
		if archivedTaskArchived != true {
			t.Errorf("expected archived task archived=true, got %v", archivedTaskArchived)
		}
	})

	t.Run("import with reset clears existing data and reimports", func(t *testing.T) {
		_, _ = db.Exec(`INSERT INTO boards (id, name) VALUES ('reset-board', 'Board To Reset')`)
		_, _ = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp-reset', 'u1', 'reset-board', 'WRITE')`)
		_, _ = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('rc1', 'Old Column', 'reset-board', 0)`)
		_, _ = db.Exec(`INSERT INTO tasks (id, title, column_id, position) VALUES ('rt1', 'Old Task', 'rc1', 0)`)

		body, _ := json.Marshal(map[string]interface{}{
			"data":    importData,
			"boardId": "reset-board",
			"reset":   true,
		})
		req, _ := http.NewRequest("POST", "/api/boards/import", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var colCount int
		db.QueryRow("SELECT COUNT(*) FROM columns WHERE board_id = 'reset-board'").Scan(&colCount)
		if colCount != 1 {
			t.Errorf("expected 1 column after reset import, got %d", colCount)
		}

		var taskCount int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = 'reset-board')").Scan(&taskCount)
		if taskCount != 2 {
			t.Errorf("expected 2 tasks after reset import, got %d", taskCount)
		}

		var oldTaskCount int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE title = 'Old Task'").Scan(&oldTaskCount)
		if oldTaskCount != 0 {
			t.Errorf("expected 0 old tasks after reset import, got %d", oldTaskCount)
		}
	})
}
