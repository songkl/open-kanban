package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupWorkspaceDB(t *testing.T) *sql.DB {
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
		enabled INTEGER DEFAULT 1,
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
		FOREIGN KEY (user_id) REFERENCES users(id)
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

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, type, role, enabled, avatar) VALUES ('u1', 'testuser', 'testuser', 'hash', 'HUMAN', 'MEMBER', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, name, key, user_id) VALUES ('t1', 'test', 'test-token', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`)
	if err != nil {
		t.Fatalf("failed to insert app config: %v", err)
	}

	return db
}

func TestWorkspaceStats(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	router := gin.New()
	router.GET("/api/v1/workspace/stats", handlers.RequireAuth(db), handlers.WorkspaceStats(db))

	t.Run("get stats without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/stats", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get stats with auth returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/stats", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}
	})
}

func TestListWorkspaceFiles(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	router := gin.New()
	router.GET("/api/v1/workspace/files", handlers.RequireAuth(db), handlers.ListWorkspaceFiles(db))

	t.Run("list files without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/files", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("list files with auth returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/files", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if _, ok := resp["files"].([]interface{}); !ok {
			t.Fatalf("expected files array in response")
		}
	})
}

func TestUploadTextFile(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	router := gin.New()
	router.POST("/api/v1/workspace/upload", handlers.RequireAuth(db), handlers.UploadTextFile(db))

	t.Run("upload without auth returns 401", func(t *testing.T) {
		body := `{"path":"test.txt","content":"hello world"}`
		req, _ := http.NewRequest("POST", "/api/v1/workspace/upload", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("upload with auth creates file", func(t *testing.T) {
		body := `{"path":"test.txt","content":"hello world"}`
		req, _ := http.NewRequest("POST", "/api/v1/workspace/upload", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		filePath := filepath.Join(tmpDir, "test.txt")
		content, err := os.ReadFile(filePath)
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(content) != "hello world" {
			t.Errorf("expected 'hello world', got '%s'", string(content))
		}
	})

	t.Run("upload with path traversal returns 400", func(t *testing.T) {
		body := `{"path":"../test.txt","content":"hello"}`
		req, _ := http.NewRequest("POST", "/api/v1/workspace/upload", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestReadWorkspaceFile(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	subDir := filepath.Join(tmpDir, "subdir")
	os.MkdirAll(subDir, 0755)
	os.WriteFile(filepath.Join(subDir, "test.txt"), []byte("test content"), 0644)

	router := gin.New()
	router.GET("/api/v1/workspace/files/*path", handlers.RequireAuth(db), handlers.ReadWorkspaceFile(db))

	t.Run("read file without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/files/test.txt", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("read existing file returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/files/subdir/test.txt", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if content, ok := resp["content"].(string); !ok || content != "test content" {
			t.Errorf("expected 'test content', got '%v'", resp["content"])
		}
	})

	t.Run("read non-existing file returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/workspace/files/nonexistent.txt", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteWorkspaceFile(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	testFile := filepath.Join(tmpDir, "todelete.txt")
	os.WriteFile(testFile, []byte("to be deleted"), 0644)

	router := gin.New()
	router.DELETE("/api/v1/workspace/files/*path", handlers.RequireAuth(db), handlers.DeleteWorkspaceFile(db))

	t.Run("delete without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/v1/workspace/files/todelete.txt", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("delete existing file returns 204", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/v1/workspace/files/todelete.txt", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Errorf("expected 204, got %d: %s", w.Code, w.Body.String())
		}

		if _, err := os.Stat(testFile); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})

	t.Run("delete non-existing file returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("DELETE", "/api/v1/workspace/files/nonexistent.txt", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestBatchUploadTextFiles(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWorkspaceDB(t)
	defer db.Close()

	tmpDir := t.TempDir()
	os.Setenv("WORKSPACE_DIR", tmpDir)
	defer os.Unsetenv("WORKSPACE_DIR")

	router := gin.New()
	router.POST("/api/v1/workspace/batch-upload", handlers.RequireAuth(db), handlers.BatchUploadTextFiles(db))

	t.Run("batch upload with auth creates files", func(t *testing.T) {
		body := `{"files":[{"path":"file1.txt","content":"content1"},{"path":"dir/file2.txt","content":"content2"}]}`
		req, _ := http.NewRequest("POST", "/api/v1/workspace/batch-upload", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		content1, err := os.ReadFile(filepath.Join(tmpDir, "file1.txt"))
		if err != nil {
			t.Fatalf("failed to read file1.txt: %v", err)
		}
		if string(content1) != "content1" {
			t.Errorf("expected 'content1', got '%s'", string(content1))
		}

		content2, err := os.ReadFile(filepath.Join(tmpDir, "dir", "file2.txt"))
		if err != nil {
			t.Fatalf("failed to read file2.txt: %v", err)
		}
		if string(content2) != "content2" {
			t.Errorf("expected 'content2', got '%s'", string(content2))
		}
	})
}
