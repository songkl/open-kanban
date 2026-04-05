package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
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

func setupTokenTestDB(t *testing.T) *sql.DB {
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
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES ('u1', 'admin', 'admin', 'pass', '', 'HUMAN', 'ADMIN', 1)`)
	if err != nil {
		t.Fatalf("failed to insert admin user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES ('u2', 'member', 'member', 'pass', '', 'HUMAN', 'MEMBER', 1)`)
	if err != nil {
		t.Fatalf("failed to insert member user: %v", err)
	}

	return db
}

func setupTokenForUser(t *testing.T, db *sql.DB, userID, tokenKey, tokenName string) {
	_, err := db.Exec(
		`INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		"token-"+tokenKey, tokenName, tokenKey, userID, time.Now(), time.Now(),
	)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
}

func TestCreateTokenHandlerFull(t *testing.T) {
	t.Run("create token with name", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/tokens", handlers.CreateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		body := map[string]interface{}{
			"name": "My New Token",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/tokens", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["token"] == nil {
			t.Fatal("expected token in response")
		}
		token := resp["token"].(map[string]interface{})
		if token["name"] != "My New Token" {
			t.Errorf("expected token name 'My New Token', got %v", token["name"])
		}
	})

	t.Run("create token with default name when name is empty", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/tokens", handlers.CreateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		body := map[string]interface{}{
			"name": "",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/tokens", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		token := resp["token"].(map[string]interface{})
		if token["name"] != "New Token" {
			t.Errorf("expected token name 'New Token', got %v", token["name"])
		}
	})

	t.Run("create token with expiresAt", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/tokens", handlers.CreateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		expiresAt := time.Now().Add(24 * time.Hour)
		body := map[string]interface{}{
			"name":      "Expiring Token",
			"expiresAt": expiresAt.Format(time.RFC3339),
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/auth/tokens", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		token := resp["token"].(map[string]interface{})
		if token["expiresAt"] == nil {
			t.Error("expected expiresAt in token")
		}
	})

	t.Run("create token with invalid body returns 400", func(t *testing.T) {
		handlers.ResetRateLimitMapForTest()
		handlers.ResetTokenCacheForTest()
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/auth/tokens", handlers.CreateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		req, _ := http.NewRequest("POST", "/api/auth/tokens", bytes.NewBuffer([]byte("invalid json")))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestUpdateTokenHandler(t *testing.T) {
	t.Run("update token name successfully", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.PUT("/api/auth/tokens", handlers.UpdateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Old Name")

		body := map[string]interface{}{
			"name": "New Name",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/auth/tokens?id=token-admin-token", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["success"] != true {
			t.Errorf("expected success=true, got %v", resp)
		}

		var name string
		err := db.QueryRow("SELECT name FROM tokens WHERE id = 'token-admin-token'").Scan(&name)
		if err != nil {
			t.Fatalf("failed to query token: %v", err)
		}
		if name != "New Name" {
			t.Errorf("expected name 'New Name', got %s", name)
		}
	})

	t.Run("update token without id returns 400", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.PUT("/api/auth/tokens", handlers.UpdateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Old Name")

		body := map[string]interface{}{
			"name": "New Name",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/auth/tokens", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update token not found returns 404", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.PUT("/api/auth/tokens", handlers.UpdateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		body := map[string]interface{}{
			"name": "New Name",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/auth/tokens?id=nonexistent", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update other user's token returns 404", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.PUT("/api/auth/tokens", handlers.UpdateToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")
		setupTokenForUser(t, db, "u2", "member-token", "Member Token")

		body := map[string]interface{}{
			"name": "Hacked Name",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/auth/tokens?id=token-member-token", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 when trying to update other user's token, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("update token without auth returns 401", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.PUT("/api/auth/tokens", handlers.UpdateToken(db))

		body := map[string]interface{}{
			"name": "New Name",
		}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/auth/tokens?id=token-admin-token", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteTokenHandlerFull(t *testing.T) {
	t.Run("delete token successfully", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/tokens", handlers.DeleteToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		req, _ := http.NewRequest("DELETE", "/api/auth/tokens?id=token-admin-token", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = 'token-admin-token'").Scan(&count)
		if err != nil {
			t.Fatalf("failed to query tokens: %v", err)
		}
		if count != 0 {
			t.Errorf("expected token to be deleted, but still exists")
		}
	})

	t.Run("delete other user's token returns 404", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/tokens", handlers.DeleteToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")
		setupTokenForUser(t, db, "u2", "member-token", "Member Token")

		req, _ := http.NewRequest("DELETE", "/api/auth/tokens?id=token-member-token", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 when deleting other user's token, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete token without id returns 400", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/tokens", handlers.DeleteToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		req, _ := http.NewRequest("DELETE", "/api/auth/tokens", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete nonexistent token returns 404", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/tokens", handlers.DeleteToken(db))

		setupTokenForUser(t, db, "u1", "admin-token", "Admin Token")

		req, _ := http.NewRequest("DELETE", "/api/auth/tokens?id=nonexistent", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete token without auth returns 401", func(t *testing.T) {
		db := setupTokenTestDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.DELETE("/api/auth/tokens", handlers.DeleteToken(db))

		req, _ := http.NewRequest("DELETE", "/api/auth/tokens?id=some-token", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})
}
