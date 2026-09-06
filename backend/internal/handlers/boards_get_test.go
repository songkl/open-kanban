package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupBoardsGetDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}

	schema := `
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
	CREATE TABLE board_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b1', 'Test Board', 'Test Description', 0, '2024-01-01 00:00:00', '2024-01-01 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	return db
}

func TestGetBoardHandler(t *testing.T) {
	db := setupBoardsGetDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/boards/:id", handlers.GetBoard(db))

	t.Run("get board with valid id returns 200", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/b1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if name, ok := resp["name"].(string); !ok || name != "Test Board" {
			t.Errorf("expected name 'Test Board', got '%v'", resp["name"])
		}

		count, ok := resp["_count"].(map[string]interface{})
		if !ok {
			t.Fatal("expected _count in response")
		}
		if columns, ok := count["columns"].(float64); !ok || columns != 2 {
			t.Errorf("expected 2 columns, got %v", columns)
		}
	})

	t.Run("get board with non-existent id returns 404", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/nonExistent", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get deleted board returns 404", func(t *testing.T) {
		_, err := db.Exec(`INSERT INTO boards (id, name, deleted) VALUES ('deleted-board', 'Deleted', 1)`)
		if err != nil {
			t.Fatalf("failed to insert deleted board: %v", err)
		}

		req, _ := http.NewRequest("GET", "/api/boards/deleted-board", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for deleted board, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("anonymous response carries empty effectiveAccess and isOwner", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards/b1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}
		if eff, _ := resp["effectiveAccess"].(string); eff != "" {
			t.Errorf("expected empty effectiveAccess, got %q", eff)
		}
		if own, _ := resp["isOwner"].(bool); own {
			t.Errorf("expected isOwner=false for anonymous, got true")
		}
	})
}

// setupBoardsGetAccessMatrixDB seeds the minimum schema for
// exercising GetBoard's per-user effectiveAccess / isOwner
// calculations. Same shape as setupBoardsAccessMatrixDB but kept
// separate so the GetBoard test file stays self-contained.
//
//	admin1 (ADMIN), admin2 (ADMIN), owner1 (MEMBER), member1
//	(MEMBER), member2 (MEMBER), viewer1 (VIEWER)
//
//	board1 — owner=owner1
//	  admin1 ADMIN, member1 WRITE, member2 READ, viewer1 READ
//	board2 — owner=admin1
//	  member1 READ (admin1 already owns it)
func setupBoardsGetAccessMatrixDB(t *testing.T) *sql.DB {
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
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		user_id TEXT NOT NULL,
		expires_at DATETIME,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	users := []struct{ id, nick, role string }{
		{"admin1", "admin-one", "ADMIN"},
		{"admin2", "admin-two", "ADMIN"},
		{"owner1", "owner-one", "MEMBER"},
		{"member1", "member-one", "MEMBER"},
		{"member2", "member-two", "MEMBER"},
		{"viewer1", "viewer-one", "VIEWER"},
	}
	for _, u := range users {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', ?, 1, '', 'HUMAN')`,
			u.id, u.id, u.nick, u.role,
		); err != nil {
			t.Fatalf("failed to seed user %s: %v", u.id, err)
		}
	}

	tokens := []struct{ id, user, key string }{
		{"tok-admin1", "admin1", "admin1-token"},
		{"tok-admin2", "admin2", "admin2-token"},
		{"tok-owner1", "owner1", "owner1-token"},
		{"tok-member1", "member1", "member1-token"},
		{"tok-member2", "member2", "member2-token"},
		{"tok-viewer1", "viewer1", "viewer1-token"},
	}
	for _, tok := range tokens {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("failed to seed token %s: %v", tok.id, err)
		}
	}

	boards := []struct{ id, name string }{
		{"board1", "Board One"},
		{"board2", "Board Two"},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name, description, deleted) VALUES (?, ?, ?, 0)`,
			b.id, b.name, b.name,
		); err != nil {
			t.Fatalf("failed to seed board %s: %v", b.id, err)
		}
	}

	rows := []struct {
		id, user, board, owner, access string
	}{
		{"bp-owner1-board1", "owner1", "board1", "owner1", "READ"},
		{"bp-admin1-board1", "admin1", "board1", "", "ADMIN"},
		{"bp-member1-board1", "member1", "board1", "", "WRITE"},
		{"bp-member2-board1", "member2", "board1", "", "READ"},
		{"bp-viewer1-board1", "viewer1", "board1", "", "READ"},
		{"bp-admin1-board2", "admin1", "board2", "admin1", "ADMIN"},
		{"bp-member1-board2", "member1", "board2", "", "READ"},
	}
	for _, r := range rows {
		var ownerArg interface{}
		if r.owner != "" {
			ownerArg = r.owner
		}
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES (?, ?, ?, ?, ?)`,
			r.id, r.user, r.board, ownerArg, r.access,
		); err != nil {
			t.Fatalf("failed to seed board permission %s: %v", r.id, err)
		}
	}

	if _, err := db.Exec(
		`INSERT INTO columns (id, name, board_id, position) VALUES ('c1-board1', 'Todo', 'board1', 0)`,
	); err != nil {
		t.Fatalf("failed to seed column: %v", err)
	}

	return db
}

// fetchBoard runs the GetBoard handler against an in-memory
// router and returns the parsed JSON record. An empty token
// simulates an anonymous call.
func fetchBoard(t *testing.T, db *sql.DB, boardID, token string) map[string]interface{} {
	t.Helper()

	router := gin.New()
	router.GET("/api/boards/:id", handlers.GetBoard(db))

	req, _ := http.NewRequest("GET", "/api/boards/"+boardID, nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	return resp
}

// TestGetBoard_AccessMatrix pins the per-user effectiveAccess /
// isOwner for board1 across every interesting (user, grant)
// combination. The cases table is the single source of truth —
// adding a new role or grant type means appending one row, not
// scattering asserts across the suite.
func TestGetBoard_AccessMatrix(t *testing.T) {
	db := setupBoardsGetAccessMatrixDB(t)
	defer db.Close()

	cases := []struct {
		name            string
		token           string
		wantEffective   string
		wantIsOwner     bool
	}{
		{
			// No auth → empty access, not owner. Backward-
			// compatible: the response shape still includes
			// both fields.
			name:          "anonymous",
			token:         "",
			wantEffective: "",
			wantIsOwner:   false,
		},
		{
			// Global ADMIN short-circuit wins over the
			// explicit ADMIN row. isOwner=false because the
			// owner_agent_id on board1 is owner1, not admin1.
			name:          "global admin with explicit ADMIN row",
			token:         "admin1-token",
			wantEffective: "ADMIN",
			wantIsOwner:   false,
		},
		{
			// Second global ADMIN has no grant row at all
			// on board1. Global ADMIN still surfaces as
			// ADMIN access; isOwner stays false.
			name:          "global admin without grant row",
			token:         "admin2-token",
			wantEffective: "ADMIN",
			wantIsOwner:   false,
		},
		{
			// owner1 is the recorded owner of board1 with
			// MEMBER global role. The owner short-circuit
			// promotes them to ADMIN even though their
			// stored access is READ.
			name:          "board owner with MEMBER role",
			token:         "owner1-token",
			wantEffective: "ADMIN",
			wantIsOwner:   true,
		},
		{
			// MEMBER with explicit WRITE grant, no owner
			// flag. Surface the stored access verbatim.
			name:          "MEMBER with WRITE grant",
			token:         "member1-token",
			wantEffective: "WRITE",
			wantIsOwner:   false,
		},
		{
			// MEMBER with explicit READ grant, no owner
			// flag.
			name:          "MEMBER with READ grant",
			token:         "member2-token",
			wantEffective: "READ",
			wantIsOwner:   false,
		},
		{
			// VIEWER with explicit READ grant. The
			// access-helper layer doesn't gate by global
			// role (requireNonViewer is handler-layer), so
			// effectiveAccess surfaces as READ here.
			name:          "VIEWER with READ grant",
			token:         "viewer1-token",
			wantEffective: "READ",
			wantIsOwner:   false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			resp := fetchBoard(t, db, "board1", tc.token)

			if eff, _ := resp["effectiveAccess"].(string); eff != tc.wantEffective {
				t.Errorf("effectiveAccess: want %q, got %q", tc.wantEffective, eff)
			}
			if own, _ := resp["isOwner"].(bool); own != tc.wantIsOwner {
				t.Errorf("isOwner: want %v, got %v", tc.wantIsOwner, own)
			}
		})
	}
}

// TestGetBoard_NoGrant_ReturnsEmptyAccess proves the
// backward-compat contract: a logged-in user with no grant on an
// existing board gets 200 with effectiveAccess="". The list
// endpoint is responsible for filtering; the single-board
// endpoint just annotates.
func TestGetBoard_NoGrant_ReturnsEmptyAccess(t *testing.T) {
	db := setupBoardsGetAccessMatrixDB(t)
	defer db.Close()

	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	// member2 has board READ on board1 but no grant on board2
	// at all. board2 exists and is not deleted, so the request
	// must succeed with empty access flags.
	resp := fetchBoard(t, db, "board2", "member2-token")

	if resp["id"] != "board2" {
		t.Errorf("expected board2, got %v", resp["id"])
	}
	if eff, _ := resp["effectiveAccess"].(string); eff != "" {
		t.Errorf("expected empty effectiveAccess for non-grant, got %q", eff)
	}
	if own, _ := resp["isOwner"].(bool); own {
		t.Errorf("expected isOwner=false, got true")
	}
}

// TestGetBoard_OwnerAdminOnDifferentBoard confirms the owner
// flag is per-board: admin1 owns board2 but only has an ADMIN
// (non-owner) row on board1, so the per-board owner flag
// reflects that exactly.
func TestGetBoard_OwnerAdminOnDifferentBoard(t *testing.T) {
	db := setupBoardsGetAccessMatrixDB(t)
	defer db.Close()

	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	resp := fetchBoard(t, db, "board2", "admin1-token")

	if eff, _ := resp["effectiveAccess"].(string); eff != "ADMIN" {
		t.Errorf("expected ADMIN on board2 for admin1 (owner), got %q", eff)
	}
	if own, _ := resp["isOwner"].(bool); !own {
		t.Errorf("expected isOwner=true on board2 for admin1, got false")
	}
}
