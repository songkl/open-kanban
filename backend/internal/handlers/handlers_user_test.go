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

func setupUserPermDB(t *testing.T) *sql.DB {
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
		type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
		role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
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
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
		UNIQUE(user_id, board_id)
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
	CREATE TABLE templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		board_id TEXT,
		columns_config TEXT NOT NULL,
		include_tasks BOOLEAN DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
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

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('admin1', 'admin', 'admin', 'pass', 'ADMIN', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert admin user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('member1', 'member', 'member', 'pass', 'MEMBER', 1, '', 'HUMAN')`)
	if err != nil {
		t.Fatalf("failed to insert member user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES ('token-admin', 'default', 'admin-token', 'admin1', datetime('now'), datetime('now'))`)
	if err != nil {
		t.Fatalf("failed to insert admin token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES ('token-member', 'default', 'member-token', 'member1', datetime('now'), datetime('now'))`)
	if err != nil {
		t.Fatalf("failed to insert member token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('board1', 'Test Board')`)
	if err != nil {
		t.Fatalf("failed to insert board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'admin1', 'board1', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert board permission: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id) VALUES ('col1', 'Test Column', 'board1')`)
	if err != nil {
		t.Fatalf("failed to insert column: %v", err)
	}

	return db
}

func TestGetPermissionsHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/permissions", handlers.GetPermissions(db))

	t.Run("get permissions without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/permissions", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get permissions as admin returns permissions", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/permissions", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot view other user permissions", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/permissions?userId=admin1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestSetPermissionHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/permissions", handlers.SetPermission(db))

	t.Run("set permission without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "boardId": "board1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot set permission returns 403", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "boardId": "board1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set permission with invalid access returns 400", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "boardId": "board1", "access": "INVALID"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set permission with missing params returns 400", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can set permission successfully", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "boardId": "board1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeletePermissionHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('perm1', 'member1', 'board1', 'WRITE')`)
	if err != nil {
		t.Fatalf("failed to insert permission: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/permissions", handlers.DeletePermission(db))

	t.Run("delete permission without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/permissions?id=perm1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot delete permission returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/permissions?id=perm1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete permission without id returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/permissions", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can delete permission", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/permissions?id=perm1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestUpdateAppConfigHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/config", handlers.UpdateAppConfig(db))

	t.Run("update config without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"allowRegistration": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/config", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot update config returns 403", func(t *testing.T) {
		body := map[string]interface{}{"allowRegistration": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/config", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can update config", func(t *testing.T) {
		body := map[string]interface{}{"allowRegistration": false, "requirePassword": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/config", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetActivitiesHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at) VALUES ('act1', 'admin1', 'LOGIN', 'SYSTEM', '', '', '', '127.0.0.1', 'web', datetime('now'))`)
	if err != nil {
		t.Fatalf("failed to insert activity: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/activities", handlers.GetActivities(db))

	t.Run("get activities without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/activities", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get activities with auth returns activities", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/activities", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["activities"] == nil {
			t.Errorf("expected activities in response")
		}
	})

	t.Run("get activities with filter", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/activities?action=LOGIN&limit=10", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member is limited to own activities", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/activities", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetUsersHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/users", handlers.GetUsers(db))

	t.Run("get users without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/users", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot get all users returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/users", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can get users", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/users", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["users"] == nil {
			t.Errorf("expected users in response")
		}
	})
}

func TestUpdateUserHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/users", handlers.UpdateUser(db))

	t.Run("update user without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"targetUserId": "member1", "nickname": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot update other user returns 403", func(t *testing.T) {
		body := map[string]interface{}{"targetUserId": "admin1", "nickname": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update without targetUserId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"nickname": "New Name"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can update user role", func(t *testing.T) {
		body := map[string]interface{}{"targetUserId": "member1", "role": "VIEWER"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update with invalid role returns 400", func(t *testing.T) {
		body := map[string]interface{}{"targetUserId": "member1", "role": "INVALID"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestSetUserEnabledHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/users/enabled", handlers.SetUserEnabled(db))

	t.Run("set user enabled without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "enabled": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot set user enabled returns 403", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "enabled": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin cannot disable themselves returns 400", func(t *testing.T) {
		body := map[string]interface{}{"userId": "admin1", "enabled": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set user enabled without userId returns 400", func(t *testing.T) {
		body := map[string]interface{}{"enabled": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can disable user", func(t *testing.T) {
		body := map[string]interface{}{"userId": "member1", "enabled": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetAgentsHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	var count int
	db.QueryRow("SELECT COUNT(*) FROM users WHERE type = 'AGENT'").Scan(&count)
	t.Logf("AGENT users count before insert: %d", count)

	_, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, type, enabled) VALUES ('agent1', 'agent1', 'Test Agent', '', 'ADMIN', 'AGENT', 1)`)
	if err != nil {
		t.Fatalf("failed to insert agent: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/agents", handlers.GetAgents(db))

	t.Run("get agents without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/agents", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get agents with auth returns agents list", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/agents", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["agents"] == nil {
			t.Errorf("expected agents in response")
		}
	})
}

func TestCreateAgentHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents", handlers.CreateAgent(db))

	t.Run("create agent without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"nickname": "New Agent"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot create agent returns 403", func(t *testing.T) {
		body := map[string]interface{}{"nickname": "New Agent"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create agent without nickname returns 400", func(t *testing.T) {
		body := map[string]interface{}{}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can create agent", func(t *testing.T) {
		body := map[string]interface{}{"nickname": "New Agent", "avatar": "🤖"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["agent"] == nil {
			t.Errorf("expected agent in response")
		}
	})
}

func TestDeleteAgentHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO users (id, username, nickname, role, type, enabled) VALUES ('agent1', 'agent1', 'Test Agent', 'ADMIN', 'AGENT', 1)`)
	if err != nil {
		t.Fatalf("failed to insert agent: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/agents", handlers.DeleteAgent(db))

	t.Run("delete agent without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/agents?id=agent1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot delete agent returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/agents?id=agent1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete agent without id returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/agents", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can delete agent", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/agents?id=agent1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestResetAgentTokenHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO users (id, username, nickname, role, type, enabled) VALUES ('agent1', 'agent1', 'Test Agent', 'ADMIN', 'AGENT', 1)`)
	if err != nil {
		t.Fatalf("failed to insert agent: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents/reset-token", handlers.ResetAgentToken(db))

	t.Run("reset agent token without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/agents/reset-token?id=agent1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot reset agent token returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/agents/reset-token?id=agent1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("reset agent token without id returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/agents/reset-token", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can reset agent token", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/agents/reset-token?id=agent1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateUserHandler(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/users", handlers.CreateUser(db))

	t.Run("create user without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"username": "newuser", "nickname": "New User"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot create user returns 403", func(t *testing.T) {
		body := map[string]interface{}{"username": "newuser", "nickname": "New User"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create user without username returns 400", func(t *testing.T) {
		body := map[string]interface{}{"nickname": "New User"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create user with duplicate username returns 409", func(t *testing.T) {
		body := map[string]interface{}{"username": "admin", "nickname": "Admin User"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusConflict {
			t.Errorf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("create user with invalid role returns 400", func(t *testing.T) {
		body := map[string]interface{}{"username": "newuser", "nickname": "New User", "role": "INVALID"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can create user", func(t *testing.T) {
		body := map[string]interface{}{"username": "newuser", "nickname": "New User", "password": "test123"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["user"] == nil {
			t.Errorf("expected user in response")
		}
	})
}

func TestGetColumnPermissionsHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/columns/permissions", handlers.GetColumnPermissions(db))

	t.Run("get column permissions without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/permissions", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get column permissions with auth returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/columns/permissions", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestSetColumnPermissionHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/columns/permissions", handlers.SetColumnPermission(db))

	t.Run("set column permission without auth returns 401", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "col1", "userId": "member1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set column permission as member returns 403", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "col1", "userId": "member1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set column permission with missing params returns 400", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "col1"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("set column permission with invalid access returns 400", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "col1", "userId": "member1", "access": "INVALID"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can set column permission", func(t *testing.T) {
		body := map[string]interface{}{"columnId": "col1", "userId": "member1", "access": "WRITE"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/columns/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteColumnPermissionHandler(t *testing.T) {
	db := setupUserPermDB(t)
	defer db.Close()

	_, err := db.Exec(`INSERT INTO column_permissions (id, user_id, column_id, access) VALUES ('cp1', 'member1', 'col1', 'WRITE')`)
	if err != nil {
		t.Fatalf("failed to insert column permission: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.DELETE("/api/columns/permissions", handlers.DeleteColumnPermission(db))

	t.Run("delete column permission without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns/permissions?id=cp1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete column permission as member returns 403", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns/permissions?id=cp1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete column permission without id returns 400", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns/permissions", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin can delete column permission", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/columns/permissions?id=cp1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGlobalRateLimitMiddleware(t *testing.T) {
	handlers.ResetRateLimitMapForTest()
	handlers.ResetGlobalRateLimitMapForTest()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(handlers.GlobalRateLimitMiddleware())
	router.GET("/test", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	t.Run("request under rate limit succeeds", func(t *testing.T) {
		for i := 0; i < 5; i++ {
			req, _ := http.NewRequest("GET", "/test", nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Errorf("expected 200, got %d", w.Code)
			}
		}
	})
}
