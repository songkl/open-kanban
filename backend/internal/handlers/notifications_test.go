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

func TestMain(m *testing.M) {
	// Each test starts from a fresh in-memory DB, but the token
	// cache is process-global. Clearing it here keeps one test's
	// cached user from leaking into another (e.g. test A inserts
	// alice with token 'token-u1'; without the reset, test B's
	// stale cache can short-circuit the DB lookup and return a
	// previously-cached user with the same token).
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
	m.Run()
}

func setupNotificationsDB(t *testing.T) *sql.DB {
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
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
		t.Fatalf("failed to create schema: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, enabled) VALUES
		('u1', 'alice', 'alice', '', 'ADMIN', 1),
		('u2', 'bob',   'bob',   '', 'MEMBER', 1),
		('u3', 'carol', 'carol', '', 'MEMBER', 0)`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key) VALUES ('t1', 'u1', 'token-u1')`); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`); err != nil {
		t.Fatalf("seed app_config: %v", err)
	}
	return db
}

func TestExtractMentions(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", []string{}},
		{"nil body", "hello world", []string{}},
		{"single mention", "hi @alice", []string{"alice"}},
		{"multiple", "@bob please review @alice and @carol", []string{"bob", "alice", "carol"}},
		{"deduplicated", "hi @bob, also @bob, and @bob!", []string{"bob"}},
		{"underscore dash", "ping @bob_42 and @alice-1", []string{"bob_42", "alice-1"}},
		{"email excluded", "contact me at user@example.com", []string{}},
		{"punctuation after", "cc @bob, and @alice.", []string{"bob", "alice"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := handlers.ExtractMentions(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("len = %d, want %d (got=%v)", len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("[%d] got %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestInsertNotificationRejectsBadSource(t *testing.T) {
	db := setupNotificationsDB(t)
	defer db.Close()

	if err := handlers.InsertNotification(db, "u1", "NOT_A_SOURCE", "title", "body", "TASK", "t1"); err == nil {
		t.Fatal("expected error for unknown source")
	}
	if err := handlers.InsertNotification(db, "", handlers.NotificationSourceTaskAssigned, "title", "body", "TASK", "t1"); err == nil {
		t.Fatal("expected error for empty userID")
	}
	if err := handlers.InsertNotification(db, "u1", handlers.NotificationSourceTaskAssigned, "title", "body", "FOO", "t1"); err == nil {
		t.Fatal("expected error for bad targetType")
	}
}

func TestInsertNotificationPersistsRow(t *testing.T) {
	db := setupNotificationsDB(t)
	defer db.Close()

	if err := handlers.InsertNotification(db, "u2", handlers.NotificationSourceTaskAssigned, "You have been assigned", "Fix the bug", "TASK", "t-42"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	var title, source, targetType, targetID string
	if err := db.QueryRow("SELECT title, source, target_type, target_id FROM notifications WHERE user_id = 'u2'").Scan(&title, &source, &targetType, &targetID); err != nil {
		t.Fatalf("query: %v", err)
	}
	if title != "You have been assigned" || source != "TASK_ASSIGNED" || targetType != "TASK" || targetID != "t-42" {
		t.Errorf("row mismatch: %q %q %q %q", title, source, targetType, targetID)
	}
}

func TestGetNotifications(t *testing.T) {
	db := setupNotificationsDB(t)
	defer db.Close()
	for _, src := range []string{
		handlers.NotificationSourceTaskAssigned,
		handlers.NotificationSourceTaskMentioned,
		handlers.NotificationSourceRunCompleted,
	} {
		if err := handlers.InsertNotification(db, "u1", src, "title", "body", "TASK", "t1"); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/notifications", handlers.GetNotifications(db))

	t.Run("unauthenticated", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/notifications", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("authenticated lists owned rows", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/notifications", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Notifications []map[string]interface{} `json:"notifications"`
			UnreadCount   int                     `json:"unreadCount"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Notifications) != 3 {
			t.Errorf("expected 3 notifications, got %d", len(resp.Notifications))
		}
		if resp.UnreadCount != 3 {
			t.Errorf("expected unreadCount=3, got %d", resp.UnreadCount)
		}
	})

	t.Run("unreadOnly filter", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/notifications?unreadOnly=true", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var resp struct {
			Notifications []map[string]interface{} `json:"notifications"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Notifications) != 3 {
			t.Errorf("expected 3 unread, got %d", len(resp.Notifications))
		}
	})
}

func TestMarkNotificationRead(t *testing.T) {
	db := setupNotificationsDB(t)
	defer db.Close()
	if err := handlers.InsertNotification(db, "u1", handlers.NotificationSourceTaskAssigned, "T", "B", "TASK", "x"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/notifications", handlers.GetNotifications(db))
	router.POST("/api/notifications/:id/read", handlers.MarkNotificationRead(db))
	router.POST("/api/notifications/read-all", handlers.MarkAllNotificationsRead(db))

	var id string
	if err := db.QueryRow("SELECT id FROM notifications LIMIT 1").Scan(&id); err != nil {
		t.Fatalf("lookup id: %v", err)
	}

	t.Run("marks single row read", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/notifications/"+id+"/read", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var readAt sql.NullTime
		if err := db.QueryRow("SELECT read_at FROM notifications WHERE id = ?", id).Scan(&readAt); err != nil {
			t.Fatalf("query: %v", err)
		}
		if !readAt.Valid {
			t.Errorf("read_at not stamped")
		}
	})

	t.Run("404 for missing id", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "/api/notifications/does-not-exist/read", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})

	t.Run("read-all marks every owned row", func(t *testing.T) {
		// Reset: clear read_at so we can observe the read-all effect.
		if _, err := db.Exec("UPDATE notifications SET read_at = NULL"); err != nil {
			t.Fatalf("reset: %v", err)
		}
		// Add a second row.
		if err := handlers.InsertNotification(db, "u1", handlers.NotificationSourceTaskMentioned, "T2", "B2", "COMMENT", "c1"); err != nil {
			t.Fatalf("seed2: %v", err)
		}
		req, _ := http.NewRequest("POST", "/api/notifications/read-all", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var unread int
		if err := db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id = 'u1' AND read_at IS NULL").Scan(&unread); err != nil {
			t.Fatalf("count: %v", err)
		}
		if unread != 0 {
			t.Errorf("expected 0 unread after read-all, got %d", unread)
		}
	})
}

func TestMarkNotificationReadDoesNotLeakOtherUsers(t *testing.T) {
	db := setupNotificationsDB(t)
	defer db.Close()
	// Seed notification owned by u2 directly via SQL.
	if _, err := db.Exec(`INSERT INTO notifications (id, user_id, source, title, body, target_type, target_id) VALUES ('n2', 'u2', 'TASK_ASSIGNED', 'secret', '', 'TASK', 'x')`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/notifications/:id/read", handlers.MarkNotificationRead(db))

	req, _ := http.NewRequest("POST", "/api/notifications/n2/read", bytes.NewBuffer(nil))
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "token-u1"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 to avoid leaking other-user rows, got %d", w.Code)
	}
	var readAt sql.NullTime
	if err := db.QueryRow("SELECT read_at FROM notifications WHERE id = 'n2'").Scan(&readAt); err != nil {
		t.Fatalf("query: %v", err)
	}
	if readAt.Valid {
		t.Errorf("u2 row should still be unread")
	}
}