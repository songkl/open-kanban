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

func setupBoardsListDB(t *testing.T) *sql.DB {
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
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b1', 'Test Board 1', 'Description 1', 0, '2024-01-01 00:00:00', '2024-01-01 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board 1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b2', 'Test Board 2', 'Description 2', 0, '2024-01-02 00:00:00', '2024-01-02 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board 2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b3', 'Deleted Board', 'Description 3', 1, '2024-01-03 00:00:00', '2024-01-03 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert deleted board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c3', 'Column 3', 'b2', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	return db
}

func TestGetBoardsHandler(t *testing.T) {
	db := setupBoardsListDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/boards", handlers.GetBoards(db))

	t.Run("get boards without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get boards with auth returns boards", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if len(resp) != 2 {
			t.Errorf("expected 2 boards (not deleted), got %d", len(resp))
		}
	})

	t.Run("get boards excludes deleted boards", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		for _, board := range resp {
			if deleted, ok := board["deleted"].(bool); ok && deleted {
				t.Error("expected deleted board to be excluded from results")
			}
			if name, ok := board["name"].(string); ok && name == "Deleted Board" {
				t.Error("expected 'Deleted Board' to be excluded from results")
			}
		}
	})

	t.Run("get boards includes column count", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		for _, board := range resp {
			boardID := board["id"].(string)
			count, ok := board["_count"].(map[string]interface{})
			if !ok {
				t.Errorf("expected _count for board %s", boardID)
				continue
			}
			columns, ok := count["columns"].(float64)
			if !ok {
				t.Errorf("expected columns count for board %s", boardID)
				continue
			}
			if boardID == "b1" && columns != 2 {
				t.Errorf("expected board b1 to have 2 columns, got %v", columns)
			}
			if boardID == "b2" && columns != 1 {
				t.Errorf("expected board b2 to have 1 column, got %v", columns)
			}
		}
	})

	t.Run("get boards ordered by created_at ASC", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if len(resp) >= 2 {
			firstBoard := resp[0]
			secondBoard := resp[1]
			firstName := firstBoard["name"].(string)
			secondName := secondBoard["name"].(string)
			if firstName != "Test Board 1" || secondName != "Test Board 2" {
				t.Errorf("expected boards in order [Test Board 1, Test Board 2], got [%s, %s]", firstName, secondName)
			}
		}
	})
}
