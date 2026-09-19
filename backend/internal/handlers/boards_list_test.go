package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func setupBoardsListDB(t *testing.T) *sql.DB {
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
		published BOOLEAN DEFAULT 0,
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
	`

	_, err = db.Exec(schema)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`)
	if err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'test-token', NULL)`)
	if err != nil {
		t.Fatalf("failed to insert test token: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b1', 'Test Board 1', 'Description 1', 0, '2024-01-01 00:00:00', '2024-01-01 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board 1: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b2', 'Test Board 2', 'Description 2', 0, '2024-01-02 00:00:00', '2024-01-02 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert test board 2: %v", err)
	}
	_, err = db.Exec(`INSERT INTO boards (id, name, description, deleted, created_at, updated_at) VALUES ('b3', 'Deleted Board', 'Description 3', 1, '2024-01-03 00:00:00', '2024-01-03 00:00:00')`)
	if err != nil {
		t.Fatalf("failed to insert deleted board: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Column 1', 'b1', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Column 2', 'b1', 1)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c3', 'Column 3', 'b2', 0)`)
	if err != nil {
		t.Fatalf("failed to insert test column: %v", err)
	}

	return db
}

func TestGetBoardsHandler(t *testing.T) {
	db := setupBoardsListDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.GET("/api/boards", handlers.GetBoards(db))

	t.Run("get boards without auth returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("get boards with auth returns boards", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if len(resp) != 2 {
			t.Errorf("expected 2 boards (not deleted), got %d", len(resp))
		}
	})

	t.Run("get boards excludes deleted boards", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		for _, board := range resp {
			if deleted, ok := board["deleted"].(bool); ok && deleted {
				t.Error("expected deleted board to be excluded from results")
			}
			if name, ok := board["name"].(string); ok && name == "Deleted Board" {
				t.Error("expected 'Deleted Board' to be excluded from results")
			}
		}
	})

	t.Run("get boards includes column count", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		for _, board := range resp {
			boardID := board["id"].(string)
			count, ok := board["_count"].(map[string]interface{})
			if !ok {
				t.Errorf("expected _count for board %s", boardID)
				continue
			}
			columns, ok := count["columns"].(float64)
			if !ok {
				t.Errorf("expected columns count for board %s", boardID)
				continue
			}
			if boardID == "b1" && columns != 2 {
				t.Errorf("expected board b1 to have 2 columns, got %v", columns)
			}
			if boardID == "b2" && columns != 1 {
				t.Errorf("expected board b2 to have 1 column, got %v", columns)
			}
		}
	})

	t.Run("get boards ordered by created_at ASC", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/boards", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp []map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if len(resp) >= 2 {
			firstBoard := resp[0]
			secondBoard := resp[1]
			firstName := firstBoard["name"].(string)
			secondName := secondBoard["name"].(string)
			if firstName != "Test Board 1" || secondName != "Test Board 2" {
				t.Errorf("expected boards in order [Test Board 1, Test Board 2], got [%s, %s]", firstName, secondName)
			}
		}
	})
}

// setupBoardsAccessMatrixDB returns a fresh SQLite seeded with a
// multi-user, multi-board matrix so the GetBoards access-filter
// tests can exercise every (user, board) combination.
//
// Seed:
//
//	admin1 (ADMIN), admin2 (ADMIN), owner1 (MEMBER), member1
//	(MEMBER), member2 (MEMBER), viewer1 (VIEWER)
//
//	board1 — owner=owner1
//	  admin1 ADMIN, member1 WRITE, member2 READ, viewer1 READ
//	board2 — owner=admin1
//	  member1 READ
//	board3 — no permissions seeded (proves the "no grant" filter
//	  hides the board from non-admin callers)
func setupBoardsAccessMatrixDB(t *testing.T) *sql.DB {
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
		due_at DATETIME,
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

	boards := []struct {
		id, name, created string
		isPublic          bool
	}{
		{"board1", "Board One", "2024-01-01 00:00:00", true},
		// board2 is private so the access-matrix tests
		// exercise the grant-only filter without the public
		// visibility escape hatch sneaking extra boards in.
		{"board2", "Board Two", "2024-01-02 00:00:00", false},
		// board3 is private and has no grants — non-admin
		// non-owner users cannot see it; ADMINs still can.
		{"board3", "Board Three (no grants, private)", "2024-01-03 00:00:00", false},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name, description, deleted, is_public, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
			b.id, b.name, b.name, b.isPublic, b.created, b.created,
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

	cols := []struct{ id, name, board string }{
		{"c1-board1", "Todo", "board1"},
		{"c2-board1", "Doing", "board1"},
		{"c1-board2", "Todo", "board2"},
	}
	for _, c := range cols {
		if _, err := db.Exec(
			`INSERT INTO columns (id, name, board_id, position) VALUES (?, ?, ?, 0)`,
			c.id, c.name, c.board,
		); err != nil {
			t.Fatalf("failed to seed column %s: %v", c.id, err)
		}
	}

	return db
}

// fetchBoards is a tiny helper that runs the GetBoards handler
// against an in-memory router and returns the parsed JSON array
// of board records. The token can be empty to simulate an
// anonymous call.
func fetchBoards(t *testing.T, db *sql.DB, token string) []map[string]interface{} {
	t.Helper()

	router := gin.New()
	router.GET("/api/boards", handlers.GetBoards(db))

	req, _ := http.NewRequest("GET", "/api/boards", nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp []map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	return resp
}

// boardByID returns the board record matching id from resp, or
// fails the test if it's missing. Centralises the "find this
// board" pattern the matrix tests use repeatedly.
func boardByID(t *testing.T, resp []map[string]interface{}, id string) map[string]interface{} {
	t.Helper()
	for _, b := range resp {
		if b["id"] == id {
			return b
		}
	}
	t.Fatalf("board %s missing from response: %+v", id, resp)
	return nil
}

// TestGetBoards_AccessMatrix pins the per-user visibility and
// per-row effectiveAccess / isOwner flags for every interesting
// caller. Each subtest pins a single user's view so adding a new
// role or grant type means appending one entry, not scattering
// ad-hoc asserts.
func TestGetBoards_AccessMatrix(t *testing.T) {
	db := setupBoardsAccessMatrixDB(t)
	defer db.Close()

	type wantRow struct {
		effectiveAccess string
		isOwner         bool
	}

	cases := []struct {
		name      string
		token     string
		wantIDs   []string
		wantByID  map[string]wantRow
	}{
		{
			name:    "anonymous sees every public board with empty access",
			token:   "",
			wantIDs: []string{"board1"},
			wantByID: map[string]wantRow{
				"board1": {effectiveAccess: "", isOwner: false},
			},
		},
		{
			name:    "global admin sees every board with ADMIN access and ownership flags",
			token:   "admin1-token",
			wantIDs: []string{"board2", "board1", "board3"},
			wantByID: map[string]wantRow{
				// admin1 is the recorded owner of board2 — owner
				// bucket wins over plain ADMIN.
				"board2": {effectiveAccess: "ADMIN", isOwner: true},
				// admin1 has explicit ADMIN on board1 (not owner)
				"board1": {effectiveAccess: "ADMIN", isOwner: false},
				// no grant row, but ADMIN short-circuits
				"board3": {effectiveAccess: "ADMIN", isOwner: false},
			},
		},
		{
			name:    "second admin without any grants still sees everything",
			token:   "admin2-token",
			wantIDs: []string{"board1", "board2", "board3"},
			wantByID: map[string]wantRow{
				"board1": {effectiveAccess: "ADMIN", isOwner: false},
				"board2": {effectiveAccess: "ADMIN", isOwner: false},
				"board3": {effectiveAccess: "ADMIN", isOwner: false},
			},
		},
		{
			name:    "board owner with MEMBER role sees only their board as ADMIN",
			token:   "owner1-token",
			wantIDs: []string{"board1"},
			wantByID: map[string]wantRow{
				// owner1's stored access is READ but the owner
				// short-circuit promotes it to ADMIN.
				"board1": {effectiveAccess: "ADMIN", isOwner: true},
			},
		},
		{
			name:    "MEMBER with WRITE on board1 and READ on board2 sees both, board1 first",
			token:   "member1-token",
			wantIDs: []string{"board1", "board2"},
			wantByID: map[string]wantRow{
				"board1": {effectiveAccess: "WRITE", isOwner: false},
				"board2": {effectiveAccess: "READ", isOwner: false},
			},
		},
		{
			name:    "MEMBER with only READ on board1 sees just that board",
			token:   "member2-token",
			wantIDs: []string{"board1"},
			wantByID: map[string]wantRow{
				"board1": {effectiveAccess: "READ", isOwner: false},
			},
		},
		{
			name:    "VIEWER with READ on board1 sees only that board",
			token:   "viewer1-token",
			wantIDs: []string{"board1"},
			wantByID: map[string]wantRow{
				"board1": {effectiveAccess: "READ", isOwner: false},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			resp := fetchBoards(t, db, tc.token)

			gotIDs := make([]string, 0, len(resp))
			for _, b := range resp {
				gotIDs = append(gotIDs, b["id"].(string))
			}
			if !stringSlicesEqual(gotIDs, tc.wantIDs) {
				t.Errorf("expected board ids %v, got %v", tc.wantIDs, gotIDs)
			}

			for id, want := range tc.wantByID {
				board := boardByID(t, resp, id)
				if eff, _ := board["effectiveAccess"].(string); eff != want.effectiveAccess {
					t.Errorf("board %s effectiveAccess: want %q, got %q", id, want.effectiveAccess, eff)
				}
				if own, _ := board["isOwner"].(bool); own != want.isOwner {
					t.Errorf("board %s isOwner: want %v, got %v", id, want.isOwner, own)
				}
			}
		})
	}
}

// TestGetBoards_SortOrderByAccess proves the authenticated
// listing is sorted by effective access (owner > ADMIN > WRITE >
// READ) desc, with created_at asc as the tiebreaker. member1
// owns both board1 (WRITE) and board2 (READ) and is the only
// caller with multiple grants, so they pin the ordering.
func TestGetBoards_SortOrderByAccess(t *testing.T) {
	db := setupBoardsAccessMatrixDB(t)
	defer db.Close()

	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	resp := fetchBoards(t, db, "member1-token")
	if len(resp) != 2 {
		t.Fatalf("expected 2 boards for member1, got %d", len(resp))
	}
	if resp[0]["id"] != "board1" {
		t.Errorf("expected board1 (WRITE) first, got %v", resp[0]["id"])
	}
	if resp[1]["id"] != "board2" {
		t.Errorf("expected board2 (READ) second, got %v", resp[1]["id"])
	}
}

// TestGetBoards_BackwardCompatibleShape confirms the existing
// fields (id, name, _count, etc.) remain unchanged so callers
// built before s-1021 keep working without code changes.
func TestGetBoards_BackwardCompatibleShape(t *testing.T) {
	db := setupBoardsAccessMatrixDB(t)
	defer db.Close()

	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	resp := fetchBoards(t, db, "admin1-token")
	board := boardByID(t, resp, "board1")

	for _, key := range []string{"id", "name", "description", "deleted", "createdAt", "updatedAt", "effectiveAccess", "isOwner", "_count"} {
		if _, ok := board[key]; !ok {
			t.Errorf("expected key %q in response, got %+v", key, board)
		}
	}
	if count, ok := board["_count"].(map[string]interface{}); ok {
		if cols, ok := count["columns"].(float64); !ok || cols != 2 {
			t.Errorf("expected board1 _count.columns=2, got %v", count["columns"])
		}
	} else {
		t.Errorf("expected _count to be a map, got %T", board["_count"])
	}
}

// stringSlicesEqual returns true iff a and b have the same
// contents in the same order.
func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// setupBoardsActivityDB returns a fresh SQLite seeded for the
// taskCount / lastActiveAt / ownerNickname tests.
//
//	board1 (public) — owner1
//	  c1-board1, c2-board1
//	    t1 (updated 2024-06-10), t2 (updated 2024-06-20)
//	    -> 2 tasks, lastActiveAt = 2024-06-20
//	board2 (public) — admin1
//	  c1-board2
//	    t3 (updated 2024-06-15)
//	    -> 1 task, lastActiveAt = 2024-06-15
//	board3 (public) — no tasks, no owner
//	  c1-board3
//	    -> 0 tasks, lastActiveAt falls back to board.updated_at
func setupBoardsActivityDB(t *testing.T) *sql.DB {
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
		user_id TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
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
		due_at DATETIME,
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
		{"admin1", "admin-one", "ADMIN"},
		{"owner1", "owner-one", "MEMBER"},
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
		{"tok-owner1", "owner1", "owner1-token"},
	}
	for _, tok := range tokens {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("seed token %s: %v", tok.key, err)
		}
	}

	boards := []struct {
		id, name, created, updated string
		isPublic                   bool
	}{
		{"board1", "Board One", "2024-01-01 00:00:00", "2024-01-01 00:00:00", true},
		{"board2", "Board Two", "2024-01-02 00:00:00", "2024-01-02 00:00:00", true},
		{"board3", "Board Three (no tasks)", "2024-01-03 00:00:00", "2024-01-03 12:00:00", true},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name, description, deleted, is_public, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
			b.id, b.name, b.name, b.isPublic, b.created, b.updated,
		); err != nil {
			t.Fatalf("seed board %s: %v", b.id, err)
		}
	}

	perms := []struct{ id, user, board, owner, access string }{
		{"bp-owner1-board1", "owner1", "board1", "owner1", "READ"},
		{"bp-admin1-board2", "admin1", "board2", "admin1", "ADMIN"},
	}
	for _, r := range perms {
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES (?, ?, ?, ?, ?)`,
			r.id, r.user, r.board, r.owner, r.access,
		); err != nil {
			t.Fatalf("seed perm %s: %v", r.id, err)
		}
	}

	cols := []struct{ id, name, board string }{
		{"c1-board1", "Todo", "board1"},
		{"c2-board1", "Doing", "board1"},
		{"c1-board2", "Todo", "board2"},
		{"c1-board3", "Todo", "board3"},
	}
	for _, c := range cols {
		if _, err := db.Exec(
			`INSERT INTO columns (id, name, board_id, position) VALUES (?, ?, ?, 0)`,
			c.id, c.name, c.board,
		); err != nil {
			t.Fatalf("seed column %s: %v", c.id, err)
		}
	}

	tasks := []struct{ id, title, column, updated string }{
		{"t1", "T1", "c1-board1", "2024-06-10 10:00:00"},
		{"t2", "T2", "c2-board1", "2024-06-20 10:00:00"},
		{"t3", "T3", "c1-board2", "2024-06-15 10:00:00"},
	}
	for _, t0 := range tasks {
		if _, err := db.Exec(
			`INSERT INTO tasks (id, title, column_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?)`,
			t0.id, t0.title, t0.column, t0.updated, t0.updated,
		); err != nil {
			t.Fatalf("seed task %s: %v", t0.id, err)
		}
	}

	return db
}

// TestGetBoards_ActivityHelpers pins the new helper fields
// (taskCount, lastActiveAt, ownerNickname) for both the
// anonymous and authenticated paths. The fixture is small
// but covers all three branches: tasks present with
// lastActiveAt = max(tasks.updated_at), tasks present on a
// board with a recorded owner (ownerNickname resolved via the
// users join), and an empty board (lastActiveAt falls back to
// board.updated_at).
func TestGetBoards_ActivityHelpers(t *testing.T) {
	db := setupBoardsActivityDB(t)
	defer db.Close()

	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	t.Run("anonymous path returns taskCount, lastActiveAt, ownerNickname", func(t *testing.T) {
		resp := fetchBoards(t, db, "")
		if len(resp) != 3 {
			t.Fatalf("expected 3 public boards, got %d", len(resp))
		}

		b1 := boardByID(t, resp, "board1")
		if c, ok := b1["taskCount"].(float64); !ok || c != 2 {
			t.Errorf("expected board1 taskCount=2, got %v (%T)", b1["taskCount"], b1["taskCount"])
		}
		// lastActiveAt on board1 should be 2024-06-20 (max of t1/t2).
		gotActive, _ := b1["lastActiveAt"].(string)
		if !strings.HasPrefix(gotActive, "2024-06-20") {
			t.Errorf("expected board1 lastActiveAt to start with 2024-06-20, got %q", gotActive)
		}
		if nick, _ := b1["ownerNickname"].(string); nick != "owner-one" {
			t.Errorf("expected board1 ownerNickname=owner-one, got %q", nick)
		}

		b2 := boardByID(t, resp, "board2")
		if c, ok := b2["taskCount"].(float64); !ok || c != 1 {
			t.Errorf("expected board2 taskCount=1, got %v (%T)", b2["taskCount"], b2["taskCount"])
		}
		gotActive, _ = b2["lastActiveAt"].(string)
		if !strings.HasPrefix(gotActive, "2024-06-15") {
			t.Errorf("expected board2 lastActiveAt to start with 2024-06-15, got %q", gotActive)
		}
		if nick, _ := b2["ownerNickname"].(string); nick != "admin-one" {
			t.Errorf("expected board2 ownerNickname=admin-one, got %q", nick)
		}

		// board3 has no tasks and no recorded owner — lastActiveAt
		// must fall back to the board's own updated_at, not be null
		// or absent.
		b3 := boardByID(t, resp, "board3")
		if c, ok := b3["taskCount"].(float64); !ok || c != 0 {
			t.Errorf("expected board3 taskCount=0, got %v (%T)", b3["taskCount"], b3["taskCount"])
		}
		gotActive, _ = b3["lastActiveAt"].(string)
		if !strings.HasPrefix(gotActive, "2024-01-03") {
			t.Errorf("expected board3 lastActiveAt to fall back to board.updated_at, got %q", gotActive)
		}
		if nick, _ := b3["ownerNickname"].(string); nick != "" {
			t.Errorf("expected board3 ownerNickname to be empty, got %q", nick)
		}
	})

	t.Run("authenticated path returns taskCount, lastActiveAt, ownerNickname", func(t *testing.T) {
		resp := fetchBoards(t, db, "admin1-token")
		if len(resp) != 3 {
			t.Fatalf("expected 3 boards for admin1, got %d", len(resp))
		}

		b1 := boardByID(t, resp, "board1")
		if c, ok := b1["taskCount"].(float64); !ok || c != 2 {
			t.Errorf("expected board1 taskCount=2, got %v (%T)", b1["taskCount"], b1["taskCount"])
		}
		if nick, _ := b1["ownerNickname"].(string); nick != "owner-one" {
			t.Errorf("expected board1 ownerNickname=owner-one, got %q", nick)
		}

		b3 := boardByID(t, resp, "board3")
		if c, ok := b3["taskCount"].(float64); !ok || c != 0 {
			t.Errorf("expected board3 taskCount=0, got %v (%T)", b3["taskCount"], b3["taskCount"])
		}
		gotActive, _ := b3["lastActiveAt"].(string)
		if !strings.HasPrefix(gotActive, "2024-01-03") {
			t.Errorf("expected board3 lastActiveAt to fall back to board.updated_at, got %q", gotActive)
		}
		if nick, _ := b3["ownerNickname"].(string); nick != "" {
			t.Errorf("expected board3 ownerNickname to be empty, got %q", nick)
		}
	})
}
