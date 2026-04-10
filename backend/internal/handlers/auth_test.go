package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func setupTestDB(t *testing.T) *sql.DB {
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
	CREATE TABLE column_agents (
		id TEXT PRIMARY KEY,
		column_id TEXT UNIQUE NOT NULL,
		agent_types TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	return db
}

func setupTestUser(t *testing.T, db *sql.DB, nickname, password, role string) (userID string) {
	userID = fmt.Sprintf("user-%s", nickname)
	_, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1)`,
		userID, nickname, nickname, password, "😊", role,
	)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	return
}

func setupTestToken(t *testing.T, db *sql.DB, userID, tokenKey string) {
	_, err := db.Exec(
		`INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		fmt.Sprintf("token-%s", userID), "default", tokenKey, userID, time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
}

func TestInitHandler(t *testing.T) {
	t.Run("init without username returns bad request", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/init", handlers.Init(db))

		body := map[string]interface{}{}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["error"] != "Username is required" {
			t.Errorf("expected error 'Username is required', got %v", resp["error"])
		}
	})

	t.Run("first init creates admin user successfully", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/init", handlers.Init(db))

		body := map[string]interface{}{
			"username": "admin",
			"avatar":   "😊",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["user"] == nil {
			t.Errorf("expected user in response, got error: %v", resp["error"])
			return
		}
		if resp["token"] == nil {
			t.Errorf("expected token in response")
			return
		}
		user := resp["user"].(map[string]interface{})
		if user["role"] != "ADMIN" {
			t.Errorf("expected first user to be ADMIN, got %v", user["role"])
		}
	})

	t.Run("init fails when users already exist", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/init", handlers.Init(db))

		setupTestUser(t, db, "existing", "", "ADMIN")

		body := map[string]interface{}{
			"nickname": "newadmin",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected status 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("init with allowRegistration config", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/init", handlers.Init(db))

		body := map[string]interface{}{
			"username":          "admin",
			"allowRegistration": false,
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var allowReg string
		err := db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowReg)
		if err != nil || allowReg != "0" {
			t.Errorf("expected allowRegistration to be '0', got %v", allowReg)
		}
	})
}

func TestLoginHandler(t *testing.T) {
	t.Run("login without credentials returns bad request", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		body := map[string]interface{}{}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("login with empty username returns bad request", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		body := map[string]interface{}{
			"username": "",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("login with new user creates account when no users exist", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")

		body := map[string]interface{}{
			"username": "newuser",
			"avatar":   "😊",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["user"] == nil {
			t.Errorf("expected user in response")
		}
		if resp["token"] == nil {
			t.Errorf("expected token in response")
		}
		user := resp["user"].(map[string]interface{})
		if user["username"] != "newuser" {
			t.Errorf("expected username 'newuser', got %v", user["username"])
		}
		if user["role"] != "ADMIN" {
			t.Errorf("expected first user to be ADMIN, got %v", user["role"])
		}
	})

	t.Run("login with existing user returns token", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")
		setupTestUser(t, db, "testuser", "", "MEMBER")

		body := map[string]interface{}{
			"username": "testuser",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["user"] == nil {
			t.Errorf("expected user in response")
		}
		if resp["token"] == nil {
			t.Errorf("expected token in response")
		}
	})

	t.Run("login with registration disabled returns forbidden", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")
		setupTestUser(t, db, "existing", "", "ADMIN")
		db.Exec("INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', '0')")

		body := map[string]interface{}{
			"username": "newuser",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected status 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("login with user that has password but no password provided returns unauthorized", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")

		hashedPw := "$2a$10$EsMrLjGrWt.cFHRnqUcnauqTOXPSTR8dTBZkUHfQbQPWKDlKvYl1y"
		_, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1)`,
			"user-with-pw", "secureuser", "Secure User", hashedPw, "😊", "MEMBER",
		)
		if err != nil {
			t.Fatalf("failed to insert test user: %v", err)
		}

		body := map[string]interface{}{
			"username": "secureuser",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401 when user with password doesn't provide password, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["requirePassword"] != true {
			t.Errorf("expected requirePassword=true in response, got %v", resp["requirePassword"])
		}
	})

	t.Run("login with user that has password but wrong password returns unauthorized", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")

		hashedPw := "$2a$10$EsMrLjGrWt.cFHRnqUcnauqTOXPSTR8dTBZkUHfQbQPWKDlKvYl1y"
		_, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1)`,
			"user-with-pw", "secureuser", "Secure User", hashedPw, "😊", "MEMBER",
		)
		if err != nil {
			t.Fatalf("failed to insert test user: %v", err)
		}

		body := map[string]interface{}{
			"username": "secureuser",
			"password": "wrongpassword",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401 when wrong password provided, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("login with user that has password and correct password succeeds", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.POST("/api/auth/login", handlers.Login(db))

		db.Exec("DELETE FROM users")

		handlers.SetSaltForTest("test-salt-for-password-hashing-32ch")
		hashedPw, err := handlers.HashPasswordWithSalt("correctpassword")
		if err != nil {
			t.Fatalf("failed to hash password: %v", err)
		}
		_, err = db.Exec(
			`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES (?, ?, ?, ?, ?, 'HUMAN', ?, 1)`,
			"user-with-pw", "secureuser", "Secure User", hashedPw, "😊", "MEMBER",
		)
		if err != nil {
			t.Fatalf("failed to insert test user: %v", err)
		}

		body := map[string]interface{}{
			"username": "secureuser",
			"password": "correctpassword",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200 when correct password provided, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["token"] == nil {
			t.Errorf("expected token in response")
		}
	})
}

func TestGetMeHandler(t *testing.T) {
	t.Run("get me without token returns ok with null user (needsSetup=true)", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/me", handlers.GetMe(db))

		db.Exec("DELETE FROM users")

		req, _ := http.NewRequest("GET", "/api/auth/me", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["user"] != nil {
			t.Errorf("expected nil user without token, got %v", resp["user"])
		}
		if resp["needsSetup"] != true {
			t.Errorf("expected needsSetup=true when no users exist, got %v", resp["needsSetup"])
		}
	})

	t.Run("get me with valid token returns user", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/me", handlers.GetMe(db))

		db.Exec("DELETE FROM users")
		userID := setupTestUser(t, db, "testuser", "", "MEMBER")
		tokenKey := "test-token-123"
		setupTestToken(t, db, userID, tokenKey)

		req, _ := http.NewRequest("GET", "/api/auth/me", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tokenKey})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["user"] == nil {
			t.Errorf("expected user with valid token")
		} else {
			user := resp["user"].(map[string]interface{})
			if user["username"] != "testuser" {
				t.Errorf("expected username 'testuser', got %v", user["username"])
			}
		}
	})

	t.Run("get me with invalid token returns unauthorized", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/me", handlers.GetMe(db))

		db.Exec("DELETE FROM users")
		setupTestUser(t, db, "testuser", "", "MEMBER")

		req, _ := http.NewRequest("GET", "/api/auth/me", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "invalid-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", w.Code)
		}
	})
}

func TestGetTokensHandler(t *testing.T) {
	t.Run("unauthorized without token returns 401", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.GET("/api/auth/token", handlers.GetTokens(db))

		req, _ := http.NewRequest("GET", "/api/auth/token", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", w.Code)
		}
	})

	t.Run("authorized returns tokens list", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.GET("/api/auth/token", handlers.GetTokens(db))

		db.Exec("DELETE FROM users")
		userID := setupTestUser(t, db, "testuser", "", "MEMBER")
		tokenKey := "test-token-123"
		setupTestToken(t, db, userID, tokenKey)

		req, _ := http.NewRequest("GET", "/api/auth/token", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tokenKey})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestCreateTokenHandler(t *testing.T) {
	t.Run("create token successfully", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/token", handlers.CreateToken(db))

		db.Exec("DELETE FROM users")
		userID := setupTestUser(t, db, "testuser", "", "MEMBER")
		tokenKey := "test-token-123"
		setupTestToken(t, db, userID, tokenKey)

		body := map[string]interface{}{
			"name": "test-token",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/token", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tokenKey})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["token"] == nil {
			t.Errorf("expected token in response")
		}
	})

	t.Run("unauthorized without token returns 401", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/token", handlers.CreateToken(db))

		body := map[string]interface{}{
			"name": "test-token",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/token", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", w.Code)
		}
	})
}

func TestDeleteTokenHandler(t *testing.T) {
	t.Run("unauthorized without token returns 401", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/token", handlers.DeleteToken(db))

		req, _ := http.NewRequest("DELETE", "/api/auth/token?id=test-id", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", w.Code)
		}
	})

	t.Run("delete token without id returns bad request", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/token", handlers.DeleteToken(db))

		db.Exec("DELETE FROM users")
		userID := setupTestUser(t, db, "testuser", "", "MEMBER")
		tokenKey := "test-token-123"
		setupTestToken(t, db, userID, tokenKey)

		req, _ := http.NewRequest("DELETE", "/api/auth/token", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tokenKey})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected status 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetAppConfigHandler(t *testing.T) {
	t.Run("get config returns ok with defaults", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/config", handlers.GetAppConfig(db))

		req, _ := http.NewRequest("GET", "/api/auth/config", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["allowRegistration"] == nil {
			t.Errorf("expected allowRegistration in response")
		}
		if resp["requirePassword"] == nil {
			t.Errorf("expected requirePassword in response")
		}
		if resp["authEnabled"] == nil {
			t.Errorf("expected authEnabled in response")
		}
	})

	t.Run("get config returns saved values", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/config", handlers.GetAppConfig(db))

		db.Exec("INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', '0')")
		db.Exec("INSERT OR REPLACE INTO app_config (key, value) VALUES ('requirePassword', '1')")

		req, _ := http.NewRequest("GET", "/api/auth/config", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["allowRegistration"] != false {
			t.Errorf("expected allowRegistration=false, got %v", resp["allowRegistration"])
		}
		if resp["requirePassword"] != true {
			t.Errorf("expected requirePassword=true, got %v", resp["requirePassword"])
		}
	})
}

func TestGetAvatarsHandler(t *testing.T) {
	t.Run("get avatars returns list", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/auth/avatars", handlers.GetAvatars())

		req, _ := http.NewRequest("GET", "/api/auth/avatars", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", w.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)

		if resp["avatars"] == nil {
			t.Errorf("expected avatars in response")
		}
		avatars := resp["avatars"].([]interface{})
		if len(avatars) == 0 {
			t.Errorf("expected non-empty avatars list")
		}
	})
}
