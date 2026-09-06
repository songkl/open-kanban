package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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
		granted_by_user_id TEXT,
		expires_at DATETIME,
		revoked_at DATETIME,
		revoked_by_user_id TEXT,
		notes TEXT DEFAULT '',
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
		granted_by_user_id TEXT,
		expires_at DATETIME,
		revoked_at DATETIME,
		revoked_by_user_id TEXT,
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

	db.SetMaxOpenConns(1)

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user admin: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u2', 'member', 'member', 'pass', 'MEMBER', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert test user member: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('u3', 'viewer', 'viewer', 'pass', 'VIEWER', 1, '', 'HUMAN')`)
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
	handlers.ResetTokenCacheForTest()
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
	handlers.ResetTokenCacheForTest()
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
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
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

func TestCreateCommentBeyondFormerLimit(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	tests := []struct {
		name       string
		content    string
		taskID     string
		wantStatus int
	}{
		{
			name:       "2001 chars (just over former 2000 limit) is accepted",
			content:    strings.Repeat("a", 2001),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			name:       "100KB content is accepted (no length limit)",
			content:    strings.Repeat("x", 100*1024),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			name:       "multibyte unicode content is accepted",
			content:    strings.Repeat("你好世界🌍", 500),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			name:       "empty content is rejected",
			content:    "",
			taskID:     "task1",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handlers.ResetRateLimitMapForTest()
			body := map[string]interface{}{"content": tt.content, "taskId": tt.taskID}
			jsonBody, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("failed to marshal request: %v", err)
			}

			req, err := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
			if err != nil {
				t.Fatalf("failed to create request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("expected status %d, got %d: %s", tt.wantStatus, w.Code, w.Body.String())
			}
		})
	}
}

func TestCreateCommentPersistsFullContent(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	longContent := strings.Repeat("Z", 5000)
	body := map[string]interface{}{"content": longContent, "taskId": "task1"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	commentID, ok := resp["id"].(string)
	if !ok || commentID == "" {
		t.Fatalf("expected non-empty comment id, got %v", resp["id"])
	}

	var stored string
	err := db.QueryRow("SELECT content FROM comments WHERE id = ?", commentID).Scan(&stored)
	if err != nil {
		t.Fatalf("failed to read stored comment: %v", err)
	}
	if stored != longContent {
		t.Errorf("stored content length = %d, want %d", len(stored), len(longContent))
	}
}

// TestCreateComment400ErrorMessages locks down the exact text of
// each 400 the CreateComment handler can return. The kanban task
// s-1018 explicitly asked for "明确原因" (a clear reason) on the
// 400s coming back from POST /api/v1/comments, so these messages are
// part of the public contract and should not silently change. If a
// future refactor rewrites any of these strings, the diff will show
// up here as a test failure.
func TestCreateComment400ErrorMessages(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	tests := []struct {
		name        string
		body        map[string]interface{}
		wantStatus  int
		wantErrMsg  string
		description string
	}{
		{
			name:        "missing content yields 'content is required'",
			body:        map[string]interface{}{"taskId": "task1"},
			wantStatus:  http.StatusBadRequest,
			wantErrMsg:  "content is required",
			description: "validator `required` on CreateCommentRequest.Content",
		},
		{
			name:        "empty content yields 'content is required'",
			body:        map[string]interface{}{"content": "", "taskId": "task1"},
			wantStatus:  http.StatusBadRequest,
			wantErrMsg:  "content is required",
			description: "empty string also trips the `required` tag",
		},
		{
			name:        "missing taskId yields 'taskId is required'",
			body:        map[string]interface{}{"content": "hello"},
			wantStatus:  http.StatusBadRequest,
			wantErrMsg:  "taskId is required",
			description: "validator `required` on CreateCommentRequest.TaskID",
		},
		{
			name:        "empty taskId yields 'taskId is required'",
			body:        map[string]interface{}{"content": "hello", "taskId": ""},
			wantStatus:  http.StatusBadRequest,
			wantErrMsg:  "taskId is required",
			description: "empty string also trips the `required` tag",
		},
		{
			name:        "unknown taskId yields 'Invalid task ID'",
			body:        map[string]interface{}{"content": "hello", "taskId": "no-such-task"},
			wantStatus:  http.StatusBadRequest,
			wantErrMsg:  "Invalid task ID",
			description: "getBoardIDForTask returns an error for a missing task",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handlers.ResetRateLimitMapForTest()
			jsonBody, err := json.Marshal(tt.body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("status: got %d want %d (body=%s)", w.Code, tt.wantStatus, w.Body.String())
			}

			var resp map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal: %v (body=%s)", err, w.Body.String())
			}
			gotMsg, _ := resp["error"].(string)
			if gotMsg != tt.wantErrMsg {
				t.Errorf("error message: got %q want %q (%s)", gotMsg, tt.wantErrMsg, tt.description)
			}
		})
	}
}

// TestCreateCommentBeyondMySQLTextLimit exercises content sizes that
// would have failed on MySQL TEXT (max 65,535 bytes) before
// migration 007_extend_comment_content widened the column to
// LONGTEXT. On SQLite, TEXT is already variable-length, so the same
// test passes either way; the test simply guarantees that any future
// regression introducing a length cap is caught at the unit-test layer
// rather than as a 500 in production.
func TestCreateCommentBeyondMySQLTextLimit(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	tests := []struct {
		name       string
		content    string
		taskID     string
		wantStatus int
	}{
		{
			// MySQL TEXT boundary; one byte over would error on TEXT.
			name:       "exactly MySQL TEXT max (65535 bytes) is accepted",
			content:    strings.Repeat("a", 65535),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			// One byte over the TEXT cap — the motivating case for
			// migration 007.
			name:       "65536 bytes (one over TEXT cap) is accepted",
			content:    strings.Repeat("b", 65536),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			// Comfortably inside LONGTEXT (4 GiB cap) territory.
			name:       "1 MiB content is accepted",
			content:    strings.Repeat("c", 1024*1024),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
		{
			// Multibyte characters at >64 KiB to verify utf8mb4 storage
			// on MySQL stays healthy.
			name:       "multibyte content above TEXT cap is accepted",
			content:    strings.Repeat("你好世界🌍", 20000),
			taskID:     "task1",
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handlers.ResetRateLimitMapForTest()
			body := map[string]interface{}{"content": tt.content, "taskId": tt.taskID}
			jsonBody, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("status: got %d want %d (body=%s)", w.Code, tt.wantStatus, w.Body.String())
			}

			if tt.wantStatus != http.StatusOK {
				return
			}

			var resp map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			gotContent, _ := resp["content"].(string)
			if gotContent != tt.content {
				t.Errorf("content round-trip: stored %d bytes, want %d", len(gotContent), len(tt.content))
			}

			commentID, _ := resp["id"].(string)
			var stored string
			if err := db.QueryRow("SELECT content FROM comments WHERE id = ?", commentID).Scan(&stored); err != nil {
				t.Fatalf("read back: %v", err)
			}
			if stored != tt.content {
				t.Errorf("db round-trip: stored %d bytes, want %d", len(stored), len(tt.content))
			}
		})
	}
}

// TestCreateCommentContentIsNot400 guards against any future
// regression that adds a length-based `max=` validator tag or a
// server-side length cap. The contract documented in s-1018 is that
// content length is NEVER a 400 condition: oversized payloads
// either succeed (up to storage cap) or fail with 5xx, never with
// 400. This test pins the contract down.
func TestCreateCommentContentLengthIsNot400(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	handlers.ResetRateLimitMapForTest()
	db := setupCommentsDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/comments", handlers.CreateComment(db))

	// Sizes picked to bracket every prior known limit:
	//   - 2000  : former validator `max=2000` cap (removed in s-1025).
	//   - 65535  : MySQL TEXT cap (widened in s-1018).
	//   - 65536  : first byte past MySQL TEXT cap.
	sizes := []int{2000, 2001, 65535, 65536}

	for _, size := range sizes {
		t.Run(t.Name()+"/"+strconv.Itoa(size)+"bytes", func(t *testing.T) {
			handlers.ResetRateLimitMapForTest()
			content := strings.Repeat("x", size)
			body := map[string]interface{}{"content": content, "taskId": "task1"}
			jsonBody, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code == http.StatusBadRequest {
				t.Fatalf("size=%d returned 400; length must not be a 400 condition (body=%s)", size, w.Body.String())
			}
			if w.Code != http.StatusOK {
				t.Fatalf("size=%d returned %d (body=%s)", size, w.Code, w.Body.String())
			}
		})
	}
}
