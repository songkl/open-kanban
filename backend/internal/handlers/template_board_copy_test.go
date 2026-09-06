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
	_ "github.com/mattn/go-sqlite3"
)

func setupTemplateOwnershipTestDB(t *testing.T) *sql.DB {
	t.Helper()

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
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
		UNIQUE(user_id, board_id)
	);
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT CHECK(status IN ('todo', 'in_progress', 'testing', 'review', 'done')),
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
		priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
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
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		task_id TEXT NOT NULL,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
	);
	CREATE TABLE templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		board_id TEXT,
		columns_config TEXT NOT NULL,
		include_tasks BOOLEAN DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT', 'APP_CONFIG_UPDATE', 'PERMISSION_GRANT', 'PERMISSION_REVOKE')),
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

	if _, err := db.Exec(schema); err != nil {
		db.Close()
		t.Fatalf("failed to create schema: %v", err)
	}

	users := []struct {
		id, username, nickname, role string
	}{
		{"admin1", "admin", "Admin", "ADMIN"},
		{"member1", "member", "Member", "MEMBER"},
		{"viewer1", "viewer", "Viewer", "VIEWER"},
	}
	for _, user := range users {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES (?, ?, ?, 'pass', '', 'HUMAN', ?, 1)`,
			user.id, user.username, user.nickname, user.role,
		); err != nil {
			db.Close()
			t.Fatalf("failed to seed user %s: %v", user.id, err)
		}
	}

	for _, token := range []struct {
		id, key, user string
	}{
		{"template-admin-token", "template-admin-token", "admin1"},
		{"template-member-token", "template-member-token", "member1"},
		{"template-viewer-token", "template-viewer-token", "viewer1"},
	} {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			token.id, token.key, token.user,
		); err != nil {
			db.Close()
			t.Fatalf("failed to seed token %s: %v", token.id, err)
		}
	}

	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('source', 'Source Board')`); err != nil {
		db.Close()
		t.Fatalf("failed to seed source board: %v", err)
	}

	permissions := []struct {
		id, user, owner, access string
	}{
		{"bp-admin", "admin1", "admin1", "ADMIN"},
		{"bp-member", "member1", "", "READ"},
		{"bp-viewer", "viewer1", "", "READ"},
	}
	for _, permission := range permissions {
		var owner interface{}
		if permission.owner != "" {
			owner = permission.owner
		}
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES (?, ?, 'source', ?, ?)`,
			permission.id, permission.user, owner, permission.access,
		); err != nil {
			db.Close()
			t.Fatalf("failed to seed permission %s: %v", permission.id, err)
		}
	}

	for _, column := range []struct {
		id, name, status, color string
		position                int
	}{
		{"source-column-1", "To Do", "todo", "#ef4444", 0},
		{"source-column-2", "Done", "done", "#22c55e", 1},
	} {
		if _, err := db.Exec(
			`INSERT INTO columns (id, name, status, position, color, board_id) VALUES (?, ?, ?, ?, ?, 'source')`,
			column.id, column.name, column.status, column.position, column.color,
		); err != nil {
			db.Close()
			t.Fatalf("failed to seed column %s: %v", column.id, err)
		}
	}

	if _, err := db.Exec(
		`INSERT INTO tasks (id, title, description, priority, column_id, position, created_by) VALUES ('source-task', 'Source Task', 'Description', 'high', 'source-column-1', 0, 'admin1')`,
	); err != nil {
		db.Close()
		t.Fatalf("failed to seed source task: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO comments (id, content, author, task_id) VALUES ('source-comment', 'Source Comment', 'admin1', 'source-task')`,
	); err != nil {
		db.Close()
		t.Fatalf("failed to seed source comment: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO subtasks (id, title, completed, task_id) VALUES ('source-subtask', 'Source Subtask', 0, 'source-task')`,
	); err != nil {
		db.Close()
		t.Fatalf("failed to seed source subtask: %v", err)
	}

	columnsConfig := `[{"name":"To Do","status":"todo","position":0,"color":"#ef4444"},{"name":"Done","status":"done","position":1,"color":"#22c55e"}]`
	if _, err := db.Exec(
		`INSERT INTO templates (id, name, columns_config) VALUES ('template1', 'Test Template', ?)`,
		columnsConfig,
	); err != nil {
		db.Close()
		t.Fatalf("failed to seed template: %v", err)
	}

	return db
}

func performTemplateRequest(t *testing.T, router http.Handler, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()

	var requestBody *bytes.Reader
	if body == nil {
		requestBody = bytes.NewReader(nil)
	} else {
		requestBody = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, path, requestBody)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func decodeTemplateID(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()

	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode response: %v; body: %s", err, w.Body.String())
	}
	if response.ID == "" {
		t.Fatalf("expected a board id, got empty response: %s", w.Body.String())
	}
	return response.ID
}

func TestCopyBoard_NonAdminUser_BecomesOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name, token, userID, role string
	}{
		{"MEMBER becomes owner", "template-member-token", "member1", "MEMBER"},
		{"VIEWER becomes owner", "template-viewer-token", "viewer1", "VIEWER"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupTemplateOwnershipTestDB(t)
			defer db.Close()
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(handlers.RequireAuth(db))
			router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))

			w := performTemplateRequest(t, router, http.MethodPost, "/api/boards/source/copy", test.token, nil)
			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
			}
			boardID := decodeTemplateID(t, w)

			var ownerID, access string
			if err := db.QueryRow(
				`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = ? AND board_id = ?`,
				test.userID, boardID,
			).Scan(&ownerID, &access); err != nil {
				t.Fatalf("failed to read owner permission: %v", err)
			}
			if ownerID != test.userID {
				t.Errorf("expected owner_agent_id=%s, got %s", test.userID, ownerID)
			}
			if access != "ADMIN" {
				t.Errorf("expected access=ADMIN, got %s", access)
			}
			if got := handlers.GetEffectiveBoardAccess(db, test.userID, boardID, test.role); got != "ADMIN" {
				t.Errorf("expected effective access ADMIN, got %s", got)
			}
		})
	}
}

func TestCopyBoard_AdminCopy_StillOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := setupTemplateOwnershipTestDB(t)
	defer db.Close()
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))

	w := performTemplateRequest(t, router, http.MethodPost, "/api/boards/source/copy", "template-admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	boardID := decodeTemplateID(t, w)

	var ownerID string
	if err := db.QueryRow(
		`SELECT owner_agent_id FROM board_permissions WHERE user_id = 'admin1' AND board_id = ?`,
		boardID,
	).Scan(&ownerID); err != nil {
		t.Fatalf("failed to read admin owner permission: %v", err)
	}
	if ownerID != "admin1" {
		t.Errorf("expected owner_agent_id=admin1, got %s", ownerID)
	}
}

func TestCopyBoard_OwnerCanManage(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name, method, token string
		body                []byte
	}{
		{"MEMBER can update", http.MethodPut, "template-member-token", []byte(`{"name":"Updated Copy","description":"Updated"}`)},
		{"MEMBER can delete", http.MethodDelete, "template-member-token", nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupTemplateOwnershipTestDB(t)
			defer db.Close()
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(handlers.RequireAuth(db))
			router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))
			router.PUT("/api/boards/:id", handlers.UpdateBoard(db))
			router.DELETE("/api/boards/:id", handlers.DeleteBoard(db))

			copyResponse := performTemplateRequest(t, router, http.MethodPost, "/api/boards/source/copy", test.token, nil)
			if copyResponse.Code != http.StatusOK {
				t.Fatalf("expected copy 200, got %d: %s", copyResponse.Code, copyResponse.Body.String())
			}
			boardID := decodeTemplateID(t, copyResponse)
			manageResponse := performTemplateRequest(t, router, test.method, "/api/boards/"+boardID, test.token, test.body)
			if manageResponse.Code != http.StatusOK {
				t.Errorf("expected management 200, got %d: %s", manageResponse.Code, manageResponse.Body.String())
			}
		})
	}
}

func TestCopyBoard_Failure_RollsBack(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name       string
		path       string
		prepare    func(*testing.T, *sql.DB)
		wantStatus int
	}{
		{
			name:       "missing source board",
			path:       "/api/boards/missing/copy",
			wantStatus: http.StatusNotFound,
		},
		{
			name: "copy operation failure",
			path: "/api/boards/source/copy",
			prepare: func(t *testing.T, db *sql.DB) {
				if _, err := db.Exec(
					`CREATE TRIGGER reject_copy_task BEFORE INSERT ON tasks WHEN NEW.title = 'Triggered Copy' BEGIN SELECT RAISE(ABORT, 'copy task rejected'); END`,
				); err != nil {
					t.Fatalf("failed to create failure trigger: %v", err)
				}
				if _, err := db.Exec(
					`INSERT INTO tasks (id, title, priority, column_id) VALUES ('triggered-task', 'Seed Trigger', 'high', 'source-column-1')`,
				); err != nil {
					t.Fatalf("failed to seed task for failure: %v", err)
				}
			},
			wantStatus: http.StatusInternalServerError,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupTemplateOwnershipTestDB(t)
			defer db.Close()
			if test.prepare != nil {
				test.prepare(t, db)
			}
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(handlers.RequireAuth(db))
			router.POST("/api/boards/:id/copy", handlers.CopyBoard(db))

			w := performTemplateRequest(t, router, http.MethodPost, test.path, "template-admin-token", nil)
			if w.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, w.Code, w.Body.String())
			}
			var copiedBoards int
			if err := db.QueryRow(
				`SELECT COUNT(*) FROM boards WHERE name = 'Source Board (副本)'`,
			).Scan(&copiedBoards); err != nil {
				t.Fatalf("failed to count copied boards: %v", err)
			}
			if copiedBoards != 0 {
				t.Errorf("expected no copied board after failure, got %d", copiedBoards)
			}
			var permissionCount int
			if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&permissionCount); err != nil {
				t.Fatalf("failed to count board permissions: %v", err)
			}
			if permissionCount != 3 {
				t.Errorf("expected only seeded permissions after rollback, got %d", permissionCount)
			}
		})
	}
}
