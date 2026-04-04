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
