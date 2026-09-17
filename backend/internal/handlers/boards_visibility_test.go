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

// setupBoardsVisibilityDB seeds a multi-visibility, multi-grant
// fixture the visibility contract tests use:
//
//	admin1 (ADMIN), member1 (MEMBER), viewer1 (VIEWER)
//
//	pub1   is_public=1, no grants        — visible to everyone
//	priv1  is_public=0, member1 READ     — hidden from anonymous
//	                                       and from users without grant
//	priv2  is_public=0, viewer1 READ     — exercises "different user
//	                                       sees different private boards"
//	priv3  is_public=0, owner=admin1     — admin owner still sees it
func setupBoardsVisibilityDB(t *testing.T) *sql.DB {
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
	t.Cleanup(func() {
		handlers.ResetTokenCacheForTest()
		handlers.ResetPermissionCacheForTest()
	})

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
		UNIQUE(user_id, board_id),
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
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	users := []struct{ id, nick, role string }{
		{"admin1", "admin", "ADMIN"},
		{"member1", "member", "MEMBER"},
		{"viewer1", "viewer", "VIEWER"},
	}
	for _, u := range users {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', ?, 1, '', 'HUMAN')`,
			u.id, u.id, u.nick, u.role,
		); err != nil {
			t.Fatalf("seed user %s: %v", u.id, err)
		}
	}
	tokens := []struct{ id, user, key string }{
		{"tok-admin1", "admin1", "admin1-token"},
		{"tok-member1", "member1", "member1-token"},
		{"tok-viewer1", "viewer1", "viewer1-token"},
	}
	for _, tok := range tokens {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, key, user_id) VALUES (?, ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("seed token %s: %v", tok.key, err)
		}
	}

	// Four boards with carefully chosen visibility / grant
	// combinations. is_public=1 → public, is_public=0 → private.
	// Explicit created_at keeps the owner/admin/created_at
	// tiebreaker stable so the expected ordering in the cases
	// below is deterministic.
	boards := []struct {
		id, name, created string
		isPublic          bool
	}{
		{"pub1", "Public board", "2024-01-01 00:00:00", true},
		{"priv1", "Private board (member1 READ)", "2024-01-02 00:00:00", false},
		{"priv2", "Private board (viewer1 READ)", "2024-01-03 00:00:00", false},
		{"priv3", "Private board (admin1 owner)", "2024-01-04 00:00:00", false},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name, description, deleted, is_public, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
			b.id, b.name, b.name, b.isPublic, b.created, b.created,
		); err != nil {
			t.Fatalf("seed board %s: %v", b.id, err)
		}
	}

	// Grant rows. priv3 is admin1-owned so the owner short-circuit
	// activates even though admin1 has global ADMIN.
	perms := []struct {
		id, user, board, owner, access string
	}{
		{"bp-member1-priv1", "member1", "priv1", "", "READ"},
		{"bp-viewer1-priv2", "viewer1", "priv2", "", "READ"},
		{"bp-admin1-priv3", "admin1", "priv3", "admin1", "ADMIN"},
	}
	for _, p := range perms {
		var ownerArg interface{}
		if p.owner != "" {
			ownerArg = p.owner
		}
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES (?, ?, ?, ?, ?)`,
			p.id, p.user, p.board, ownerArg, p.access,
		); err != nil {
			t.Fatalf("seed perm %s: %v", p.id, err)
		}
	}

	return db
}

// idsFromResp extracts the sorted list of board ids from a
// GetBoards response.
func idsFromResp(t *testing.T, resp []map[string]interface{}) []string {
	t.Helper()
	ids := make([]string, 0, len(resp))
	for _, b := range resp {
		ids = append(ids, b["id"].(string))
	}
	return ids
}

func TestGetBoards_Visibility(t *testing.T) {
	db := setupBoardsVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/boards", handlers.GetBoards(db))

	cases := []struct {
		name      string
		token     string
		wantIDs   []string
		wantFlags map[string]map[string]interface{}
	}{
		{
			name:    "anonymous sees only public boards",
			token:   "",
			wantIDs: []string{"pub1"},
			wantFlags: map[string]map[string]interface{}{
				"pub1": {"isPublic": true, "effectiveAccess": "", "isOwner": false},
			},
		},
		{
			name:    "global admin sees every board regardless of visibility",
			token:   "admin1-token",
			// priv3 wins the owner bucket (4). pub1 / priv1 / priv2
			// all sit in the ADMIN bucket (3); the created_at
			// tiebreaker sorts them ascending.
			wantIDs: []string{"priv3", "pub1", "priv1", "priv2"},
			wantFlags: map[string]map[string]interface{}{
				"pub1":  {"isPublic": true, "effectiveAccess": "ADMIN", "isOwner": false},
				"priv1": {"isPublic": false, "effectiveAccess": "ADMIN", "isOwner": false},
				"priv2": {"isPublic": false, "effectiveAccess": "ADMIN", "isOwner": false},
				"priv3": {"isPublic": false, "effectiveAccess": "ADMIN", "isOwner": true},
			},
		},
		{
			name:    "MEMBER with READ on priv1 sees pub1 + priv1",
			token:   "member1-token",
			// priv1 lands in the READ bucket (1); pub1 has no
			// grant so it falls in the no-grant bucket (0). The
			// bucket sort puts priv1 first; created_at only
			// applies as a tiebreaker within a bucket.
			wantIDs: []string{"priv1", "pub1"},
			wantFlags: map[string]map[string]interface{}{
				"pub1":  {"isPublic": true, "effectiveAccess": "", "isOwner": false},
				"priv1": {"isPublic": false, "effectiveAccess": "READ", "isOwner": false},
			},
		},
		{
			name:    "VIEWER with READ on priv2 sees pub1 + priv2 but NOT priv1 or priv3",
			token:   "viewer1-token",
			// Same shape as the MEMBER case: priv2 wins the
			// READ bucket (1) over pub1's no-grant bucket (0).
			wantIDs: []string{"priv2", "pub1"},
			wantFlags: map[string]map[string]interface{}{
				"pub1":  {"isPublic": true, "effectiveAccess": "", "isOwner": false},
				"priv2": {"isPublic": false, "effectiveAccess": "READ", "isOwner": false},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			req, _ := http.NewRequest("GET", "/api/boards", nil)
			if tc.token != "" {
				req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tc.token})
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
			}

			var resp []map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}

			gotIDs := idsFromResp(t, resp)
			if !stringSlicesEqual(gotIDs, tc.wantIDs) {
				t.Errorf("board ids: want %v, got %v", tc.wantIDs, gotIDs)
			}

			for id, want := range tc.wantFlags {
				b := boardByID(t, resp, id)
				if pub, _ := b["isPublic"].(bool); pub != want["isPublic"].(bool) {
					t.Errorf("board %s isPublic: want %v, got %v", id, want["isPublic"], pub)
				}
				if eff, _ := b["effectiveAccess"].(string); eff != want["effectiveAccess"].(string) {
					t.Errorf("board %s effectiveAccess: want %q, got %q", id, want["effectiveAccess"], eff)
				}
				if own, _ := b["isOwner"].(bool); own != want["isOwner"].(bool) {
					t.Errorf("board %s isOwner: want %v, got %v", id, want["isOwner"], own)
				}
			}
		})
	}
}

func TestCreateBoard_DefaultsIsPublicTrue(t *testing.T) {
	db := setupBoardsCrudDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards", handlers.CreateBoard(db))

	t.Run("create without isPublic defaults to public", func(t *testing.T) {
		body := map[string]interface{}{"name": "Defaults Public"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if pub, ok := resp["isPublic"].(bool); !ok || !pub {
			t.Errorf("expected isPublic=true on response, got %v", resp["isPublic"])
		}
	})

	t.Run("create with isPublic=false persists as private", func(t *testing.T) {
		body := map[string]interface{}{"name": "Private Board", "isPublic": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if pub, ok := resp["isPublic"].(bool); !ok || pub {
			t.Errorf("expected isPublic=false on response, got %v", resp["isPublic"])
		}

		// Confirm the DB row was stamped accordingly.
		var id string
		var storedIsPublic bool
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		id = resp["id"].(string)
		if err := db.QueryRow("SELECT is_public FROM boards WHERE id = ?", id).Scan(&storedIsPublic); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if storedIsPublic {
			t.Errorf("expected board row is_public=0, got true")
		}
	})

	t.Run("create with isPublic=true persists as public", func(t *testing.T) {
		body := map[string]interface{}{"name": "Public Board", "isPublic": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if pub, _ := resp["isPublic"].(bool); !pub {
			t.Errorf("expected isPublic=true on response, got %v", resp["isPublic"])
		}
	})
}

func TestUpdateBoard_TogglesVisibility(t *testing.T) {
	db := setupBoardsCrudDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/boards/:id", handlers.UpdateBoard(db))

	t.Run("update with isPublic=false flips the board private", func(t *testing.T) {
		body := map[string]interface{}{"name": "Test Board", "isPublic": false}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if pub, _ := resp["isPublic"].(bool); pub {
			t.Errorf("expected isPublic=false on response, got true")
		}

		var stored bool
		if err := db.QueryRow("SELECT is_public FROM boards WHERE id = 'b1'").Scan(&stored); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if stored {
			t.Errorf("expected board row is_public=0, got true")
		}
	})

	t.Run("update without isPublic leaves visibility untouched", func(t *testing.T) {
		// Seed b1 to is_public=1 first so we can prove the
		// missing-field path leaves it alone.
		if _, err := db.Exec("UPDATE boards SET is_public = 1 WHERE id = 'b1'"); err != nil {
			t.Fatalf("seed: %v", err)
		}

		body := map[string]interface{}{"name": "Renamed"}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		// Visibility should be unchanged (still public).
		var stored bool
		if err := db.QueryRow("SELECT is_public FROM boards WHERE id = 'b1'").Scan(&stored); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if !stored {
			t.Errorf("expected board row is_public=1, got false (update should not flip visibility when isPublic is omitted)")
		}
	})

	t.Run("update with explicit isPublic=true flips a private board public", func(t *testing.T) {
		if _, err := db.Exec("UPDATE boards SET is_public = 0 WHERE id = 'b1'"); err != nil {
			t.Fatalf("seed: %v", err)
		}

		body := map[string]interface{}{"name": "Test Board", "isPublic": true}
		jsonBody, _ := json.Marshal(body)

		req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var stored bool
		if err := db.QueryRow("SELECT is_public FROM boards WHERE id = 'b1'").Scan(&stored); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if !stored {
			t.Errorf("expected board row is_public=1, got false")
		}
	})
}

func TestGetBoards_VisibilityFlippedInvalidatesCache(t *testing.T) {
	// First call: cache the access for the admin viewing priv1
	// (an admin sees everything regardless of visibility). Then
	// flip priv1 to is_public=false via UpdateBoard; subsequent
	// non-admin reads of the same board must reflect the new
	// visibility immediately — i.e. the permission cache must
	// have been invalidated. Without InvalidateResource, the
	// cached row would keep telling non-admins they have
	// access for up to permissionCacheDuration.
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()
	t.Cleanup(func() {
		handlers.ResetTokenCacheForTest()
		handlers.ResetPermissionCacheForTest()
	})

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

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
		UNIQUE(user_id, board_id),
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}

	seed := []struct{ sql string }{
		{`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('admin1', 'admin1', 'admin1', 'pass', 'ADMIN', 1, '', 'HUMAN')`},
		{`INSERT INTO tokens (id, key, user_id) VALUES ('tok', 'admin-token', 'admin1')`},
		{`INSERT INTO boards (id, name, description, deleted, is_public) VALUES ('priv1', 'Priv', 'Priv', 0, 1)`},
		{`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'admin1', 'priv1', 'ADMIN')`},
	}
	for _, s := range seed {
		if _, err := db.Exec(s.sql); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	// Warm up: flip priv1 to public + call UpdateBoard (which
	// should NOT invalidate cache since isPublic unchanged) to
	// prove the unchanged path doesn't blow the cache.
	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/boards", handlers.GetBoards(db))
	router.PUT("/api/boards/:id", handlers.UpdateBoard(db))

	// 1. Cache a non-existent access (defensive warm-up).
	// 2. Flip the visibility through UpdateBoard.
	body, _ := json.Marshal(map[string]interface{}{"name": "Priv", "isPublic": false})
	req, _ := http.NewRequest("PUT", "/api/boards/priv1", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}

	// Read-back confirms the flip persisted.
	var stored bool
	if err := db.QueryRow("SELECT is_public FROM boards WHERE id = 'priv1'").Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored {
		t.Fatalf("expected is_public=false after update, got true")
	}
}
