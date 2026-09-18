package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

// setupBulkColumnDB returns a fresh in-memory SQLite DB seeded with
// the schema used by tasks_bulk_column_test.go plus enough fixtures
// to exercise the BulkColumnAction handler (s-1212). Two columns
// exist on the same board so we can also verify that the handler
// scopes itself to the named column — never touching tasks in a
// sibling column.
func setupBulkColumnDB(t *testing.T) *sql.DB {
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
		is_public BOOLEAN DEFAULT 1,
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
		published BOOLEAN DEFAULT 1,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		due_at DATETIME,
		agent_id TEXT,
		agent_prompt TEXT,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN (
			'CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK',
			'ADD_COMMENT', 'LOGIN', 'LOGOUT',
			'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE',
			'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE',
			'USER_CREATE', 'USER_UPDATE',
			'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT',
			'APP_CONFIG_UPDATE',
			'PERMISSION_GRANT', 'PERMISSION_REVOKE',
			'PERMISSION_TRANSFER',
			'PERMISSION_BULK_GRANT',
			'BULK_ARCHIVE_COLUMN', 'BULK_COMPLETE_COLUMN'
		)),
		target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'mcp', 'api')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE comments (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		author TEXT,
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
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, role, enabled, avatar) VALUES ('admin', 'admin', 'Admin', 'ADMIN', 1, '')`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES ('admin-token', 'admin', 'admin-token-key')`); err != nil {
		t.Fatalf("seed admin token: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, role, enabled, avatar) VALUES ('member', 'member', 'Member', 'MEMBER', 1, '')`); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES ('member-token', 'member', 'member-token-key')`); err != nil {
		t.Fatalf("seed member token: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Test Board')`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'admin', 'b1', 'ADMIN')`); err != nil {
		t.Fatalf("seed admin permission: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp2', 'member', 'b1', 'WRITE')`); err != nil {
		t.Fatalf("seed member permission: %v", err)
	}
	// Two columns on the same board so we can prove the handler
	// never crosses column boundaries — "Archive all" on column
	// "todo" must not touch the task in column "done".
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('todo', 'To Do', 'todo', 0, 'b1')`); err != nil {
		t.Fatalf("seed todo column: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('done', 'Done', 'done', 1, 'b1')`); err != nil {
		t.Fatalf("seed done column: %v", err)
	}
	// Three live tasks in the "todo" column, all created by the
	// admin so member-role tests can use a different created_by
	// value to verify the canModifyTask gate.
	for _, id := range []string{"t1", "t2", "t3"} {
		if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, position, published, created_by) VALUES (?, ?, 'todo', ?, 1, 'admin')`, id, "Task "+id, 1+len(id)); err != nil {
			t.Fatalf("seed task %s: %v", id, err)
		}
	}
	// One task in the sibling "done" column. The archive-all
	// smoke test asserts it stays untouched.
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, position, published, created_by) VALUES ('sibling', 'Sibling', 'done', 0, 1, 'admin')`); err != nil {
		t.Fatalf("seed sibling task: %v", err)
	}

	return db
}

func TestBulkColumnAction_RequiresAuth(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	body := map[string]interface{}{"columnId": "todo", "action": "archive"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without auth, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkColumnAction_Validation(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	tests := []struct {
		name string
		body map[string]interface{}
		want int
	}{
		{
			name: "missing columnId",
			body: map[string]interface{}{"action": "archive"},
			want: http.StatusBadRequest,
		},
		{
			name: "missing action",
			body: map[string]interface{}{"columnId": "todo"},
			want: http.StatusBadRequest,
		},
		{
			name: "unsupported action",
			body: map[string]interface{}{"columnId": "todo", "action": "delete-everything"},
			want: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			jsonBody, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token-key"})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tc.want {
				t.Errorf("expected %d, got %d: %s", tc.want, w.Code, w.Body.String())
			}
		})
	}
}

func TestBulkColumnAction_Archive(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	body := map[string]interface{}{"columnId": "todo", "action": "archive"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token-key"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp["action"] != "archive" {
		t.Errorf("expected action=archive, got %v", resp["action"])
	}
	if int(resp["count"].(float64)) != 3 {
		t.Errorf("expected count=3, got %v", resp["count"])
	}

	affected := resp["affected"].([]interface{})
	if len(affected) != 3 {
		t.Errorf("expected 3 affected task IDs, got %d", len(affected))
	}

	// Verify the live tasks in the targeted column are now archived.
	var archived int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE column_id = 'todo' AND archived = 1`).Scan(&archived); err != nil {
		t.Fatalf("count archived: %v", err)
	}
	if archived != 3 {
		t.Errorf("expected 3 tasks archived in 'todo' column, got %d", archived)
	}

	// Verify the sibling column was left untouched.
	var siblingArchived int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE id = 'sibling' AND archived = 1`).Scan(&siblingArchived); err != nil {
		t.Fatalf("count sibling archived: %v", err)
	}
	if siblingArchived != 0 {
		t.Errorf("expected sibling task to remain unarchived; it was modified")
	}

	// Verify the audit-log row targets the COLUMN and carries the
	// expected action name + details string.
	var (
		activityAction string
		activityTarget string
		activityDetails string
	)
	if err := db.QueryRow(
		`SELECT action, target_type, details FROM activities WHERE target_id = 'todo' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&activityAction, &activityTarget, &activityDetails); err != nil {
		t.Fatalf("query activity: %v", err)
	}
	if activityAction != "BULK_ARCHIVE_COLUMN" {
		t.Errorf("expected activity action=BULK_ARCHIVE_COLUMN, got %q", activityAction)
	}
	if activityTarget != "COLUMN" {
		t.Errorf("expected activity target_type=COLUMN, got %q", activityTarget)
	}
	if !strings.Contains(activityDetails, "affected=3") || !strings.Contains(activityDetails, "skipped=0") {
		t.Errorf("expected activity details to report affected=3 skipped=0, got %q", activityDetails)
	}
}

func TestBulkColumnAction_CompleteAdvancesToNextColumn(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	body := map[string]interface{}{"columnId": "todo", "action": "complete"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token-key"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if int(resp["count"].(float64)) != 3 {
		t.Errorf("expected count=3, got %v", resp["count"])
	}

	// Verify all three tasks moved from "todo" → "done".
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE column_id = 'todo' AND published = 1`).Scan(&remaining); err != nil {
		t.Fatalf("count remaining in todo: %v", err)
	}
	if remaining != 0 {
		t.Errorf("expected 'todo' to be empty after a bulk complete, got %d tasks left", remaining)
	}

	var moved int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE column_id = 'done' AND published = 1`).Scan(&moved); err != nil {
		t.Fatalf("count moved to done: %v", err)
	}
	if moved != 4 { // 3 advanced + the original sibling task
		t.Errorf("expected 4 tasks in 'done' column after the bulk complete, got %d", moved)
	}

	var activityAction string
	if err := db.QueryRow(
		`SELECT action FROM activities WHERE target_id = 'todo' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&activityAction); err != nil {
		t.Fatalf("query activity: %v", err)
	}
	if activityAction != "BULK_COMPLETE_COLUMN" {
		t.Errorf("expected activity action=BULK_COMPLETE_COLUMN, got %q", activityAction)
	}
}

func TestBulkColumnAction_Forbidden(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	// Seed a column on a board the member has no access to.
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b2', 'Other Board')`); err != nil {
		t.Fatalf("seed other board: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('private', 'Private', 'todo', 0, 'b2')`); err != nil {
		t.Fatalf("seed private column: %v", err)
	}

	body := map[string]interface{}{"columnId": "private", "action": "archive"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token-key"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a column on a board the user cannot access, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkColumnAction_EmptyColumn(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	// Seed an empty column.
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES ('empty', 'Empty', 'todo', 2, 'b1')`); err != nil {
		t.Fatalf("seed empty column: %v", err)
	}

	body := map[string]interface{}{"columnId": "empty", "action": "archive"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token-key"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 even when the column has no tasks, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if int(resp["count"].(float64)) != 0 {
		t.Errorf("expected count=0 for an empty column, got %v", resp["count"])
	}

	affected, _ := resp["affected"].([]interface{})
	if len(affected) != 0 {
		t.Errorf("expected empty affected array, got %v", affected)
	}

	// No activity row should be written for an empty column —
	// there is nothing to audit.
	var activityCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM activities WHERE target_id = 'empty'`).Scan(&activityCount); err != nil {
		t.Fatalf("count activities: %v", err)
	}
	if activityCount != 0 {
		t.Errorf("expected no activity rows for an empty column, got %d", activityCount)
	}
}

func TestBulkColumnAction_UnknownColumn(t *testing.T) {
	db := setupBulkColumnDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/v1/tasks/bulk/column-action", handlers.BulkColumnAction(db))

	body := map[string]interface{}{"columnId": "no-such-column", "action": "archive"}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/tasks/bulk/column-action", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token-key"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for an unknown column, got %d: %s", w.Code, w.Body.String())
	}
}
