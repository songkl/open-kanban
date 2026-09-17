package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupRunsDB(t *testing.T) *sql.DB {
	// Use a unique shared-cache DSN per test so every connection
	// pulled from the pool sees the same schema. The bare ":memory:"
	// DSN would create a fresh DB per connection, which manifests
	// as the goroutine spawned by MarkRunComplete hitting
	// "no such table: notifications" because the connection pool
	// hands it a connection that doesn't share state with the one
	// the test setup wrote to.
	dsn := "file:runstest-" + t.Name() + "?mode=memory&cache=shared"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
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
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		board_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		color TEXT DEFAULT '#6b7280',
		description TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
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
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
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
	CREATE TABLE notifications (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source TEXT NOT NULL CHECK(source IN ('TASK_ASSIGNED', 'TASK_MENTIONED', 'RUN_COMPLETED', 'WEBHOOK_FAILED')),
		title TEXT NOT NULL,
		body TEXT NOT NULL DEFAULT '',
		target_type TEXT NOT NULL DEFAULT '' CHECK(target_type IN ('', 'TASK', 'COMMENT', 'RUN', 'WEBHOOK')),
		target_id TEXT NOT NULL DEFAULT '',
		read_at DATETIME,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	var nTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','tokens','boards','columns','tasks','notifications','app_config')").Scan(&nTables); err != nil {
		t.Fatalf("table check: %v", err)
	}
	if nTables != 7 {
		t.Fatalf("expected 7 tables, got %d", nTables)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, enabled) VALUES
		('u1', 'alice', 'alice', '', 'ADMIN', 1),
		('u2', 'bob',   'bob',   '', 'MEMBER', 1)`); err != nil {
		t.Fatalf("users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES ('t1', 'u1', 'token-u1')`); err != nil {
		t.Fatalf("token: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`); err != nil {
		t.Fatalf("app_config: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'B')`); err != nil {
		t.Fatalf("board: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, board_id) VALUES ('c1', 'C', 'b1')`); err != nil {
		t.Fatalf("column: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task-1', 'Fix it', 'c1', 'u1')`); err != nil {
		t.Fatalf("task: %v", err)
	}
	return db
}

func TestMarkRunCompleteFansOutNotification(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupRunsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/runs/:taskId/complete", handlers.MarkRunComplete(db))

	body := strings.NewReader(`{"status":"completed","detail":"all good"}`)
	req, _ := http.NewRequest("POST", "/api/runs/task-1/complete", body)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Wait briefly for the goroutine to insert the notification row.
	deadline := 100
	for i := 0; i < deadline; i++ {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id = 'u1'").Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		if n > 0 {
			break
		}
	}
	var source, title, bodyCol string
	var targetType, targetID string
	if err := db.QueryRow(`SELECT source, title, body, target_type, target_id FROM notifications WHERE user_id='u1' LIMIT 1`).Scan(&source, &title, &bodyCol, &targetType, &targetID); err != nil {
		t.Fatalf("query: %v", err)
	}
	if source != handlers.NotificationSourceRunCompleted {
		t.Errorf("expected source=RUN_COMPLETED, got %q", source)
	}
	if title != "Run completed" {
		t.Errorf("expected title 'Run completed', got %q", title)
	}
	if targetType != "RUN" || targetID != "task-1" {
		t.Errorf("expected target RUN/task-1, got %s/%s", targetType, targetID)
	}
}

func TestMarkRunCompleteNotFoundForMissingTask(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupRunsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/runs/:taskId/complete", handlers.MarkRunComplete(db))

	req, _ := http.NewRequest("POST", "/api/runs/does-not-exist/complete", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestMarkRunCompleteRequiresAuth(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupRunsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/runs/:taskId/complete", handlers.MarkRunComplete(db))

	req, _ := http.NewRequest("POST", "/api/runs/task-1/complete", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
	// Sanity-check: no spurious notification was inserted.
	var n int
	_ = db.QueryRow("SELECT COUNT(*) FROM notifications").Scan(&n)
	if n != 0 {
		t.Errorf("expected no notifications, got %d", n)
	}
	_ = json.RawMessage{}
}