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

func setupBoardsGetDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}

	schema := `
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

	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b1', 'Test Board', 'Test Description', 0, '2024-01-01 00:00:00', '2024-01-01 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	return db
}

func TestGetBoardHandler(t *testing.T) {
	db := setupBoardsGetDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/boards/:id", handlers.GetBoard(db))

	t.Run("get board with valid id returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/b1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if name, ok := resp["name"].(string); !ok || name != "Test Board" {
			t.Errorf("expected name 'Test Board', got '%v'", resp["name"])
		}

		count, ok := resp["_count"].(map[string]interface{})
		if !ok {
			t.Fatal("expected _count in response")
		}
		if columns, ok := count["columns"].(float64); !ok || columns != 2 {
			t.Errorf("expected 2 columns, got %v", columns)
		}
	})

	t.Run("get board with non-existent id returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/nonExistent", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get deleted board returns 404", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('deleted-board', 'Deleted', 1)`)
		if err != nil {
			t.Fatalf("failed to insert deleted board: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/boards/deleted-board", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for deleted board, got %d: %s", w.Code, w.Body.String())
		}
	})
}
