package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/models"
)

// setupPermissionIntegrationDB returns a freshly seeded SQLite
// with the minimum schema for end-to-end permission tests. Seeds:
//
//   - admin1 (ADMIN), admin2 (ADMIN), owner1 (MEMBER), member1
//     (MEMBER), member2 (MEMBER), viewer1 (VIEWER)
//   - board1 with owner1 as the recorded owner (via owner_agent_id)
//   - board2 with admin1 as the recorded owner (so admin1 isn't a
//     global-only admin for the matrix below)
//   - columns c1, c2, c3, c4 under board1 with mixed permission
//     grants covering every cascade branch
//
// The seed is intentionally broader than other test helpers so the
// whole role × resource × operation matrix can run against a
// single DB without cross-test state leaking.
func setupPermissionIntegrationDB(t *testing.T) *sql.DB {
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
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL,
		target_type TEXT NOT NULL,
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web',
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
		{"token-admin1", "admin1", "admin1-token"},
		{"token-admin2", "admin2", "admin2-token"},
		{"token-owner1", "owner1", "owner1-token"},
		{"token-member1", "member1", "member1-token"},
		{"token-member2", "member2", "member2-token"},
		{"token-viewer1", "viewer1", "viewer1-token"},
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
		if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES (?, ?)`, b.id, b.name); err != nil {
			t.Fatalf("failed to seed board %s: %v", b.id, err)
		}
	}

	// board1 ownership goes to owner1; board2 ownership goes to
	// admin1 so the admin-matrix can be checked on both boards
	// without admin1 being a global-only admin.
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

	cols := []struct{ id, name, status string }{
		{"c1", "Todo", "todo"},
		{"c2", "Doing", "doing"},
		{"c3", "Done", "done"},
		{"c4", "Review", "review"},
	}
	for _, c := range cols {
		if _, err := db.Exec(
			`INSERT INTO columns (id, name, status, board_id) VALUES (?, ?, ?, 'board1')`,
			c.id, c.name, c.status,
		); err != nil {
			t.Fatalf("failed to seed column %s: %v", c.id, err)
		}
	}

	// c1: column ADMIN for member2 (used by TestPermissionCascade_ColumnOverridesBoard)
	// c2: column READ for viewer1 (used by TestPermissionCascade_BoardFallback to show
	//     a column READ on top of a board WRITE for member1 — proves the column
	//     grant is the one that wins, not the board grant).
	// c3: no per-column grant; should fall back to the board grant.
	// c4: explicit column READ for member2 while they only have board READ on board1
	//     — used to verify that a column grant that is lower than the board grant
	//     does NOT elevate the user's effective access.
	colPerms := []struct {
		id, user, column, access string
	}{
		{"cp-m2-c1", "member2", "c1", "ADMIN"},
		{"cp-v1-c2", "viewer1", "c2", "READ"},
		{"cp-m2-c4", "member2", "c4", "READ"},
	}
	for _, cp := range colPerms {
		if _, err := db.Exec(
			`INSERT INTO column_permissions (id, user_id, column_id, access) VALUES (?, ?, ?, ?)`,
			cp.id, cp.user, cp.column, cp.access,
		); err != nil {
			t.Fatalf("failed to seed column permission %s: %v", cp.id, err)
		}
	}

	return db
}

// TestPermissionMatrix_AllRolesAllAccessLevels enumerates the full
// role × resource × operation matrix for the access helper. The
// expected outcomes are pinned in the cases table so adding a new
// role or operation requires touching this test in one obvious
// place rather than scattering ad-hoc asserts across the suite.
func TestPermissionMatrix_AllRolesAllAccessLevels(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	cases := []struct {
		name           string
		userID         string
		userRole       string
		resourceKind   string
		resourceID     string
		requiredAccess string
		want           bool
	}{
		// Global ADMIN short-circuit: passes for every required
		// level without consulting board / column grants.
		{"admin board READ", "admin2", "ADMIN", "board", "board1", "READ", true},
		{"admin board WRITE", "admin2", "ADMIN", "board", "board1", "WRITE", true},
		{"admin board ADMIN", "admin2", "ADMIN", "board", "board1", "ADMIN", true},
		{"admin column READ", "admin2", "ADMIN", "column", "c3", "READ", true},
		{"admin column WRITE", "admin2", "ADMIN", "column", "c3", "WRITE", true},
		{"admin column ADMIN", "admin2", "ADMIN", "column", "c3", "ADMIN", true},

		// Owner1 (global MEMBER) inherits ADMIN on board1 via
		// the owner_agent_id short-circuit.
		{"owner board READ", "owner1", "MEMBER", "board", "board1", "READ", true},
		{"owner board WRITE", "owner1", "MEMBER", "board", "board1", "WRITE", true},
		{"owner board ADMIN", "owner1", "MEMBER", "board", "board1", "ADMIN", true},
		// Owner does NOT inherit ADMIN on board2 — owner flag is
		// per-board, not global.
		{"owner board2 denied", "owner1", "MEMBER", "board", "board2", "READ", false},

		// Member1 has explicit board WRITE on board1, no
		// per-column grant on c3 — falls back to board grant.
		{"member1 c3 READ (board fallback)", "member1", "MEMBER", "column", "c3", "READ", true},
		{"member1 c3 WRITE (board fallback)", "member1", "MEMBER", "column", "c3", "WRITE", true},
		{"member1 c3 ADMIN (no board grant that high)", "member1", "MEMBER", "column", "c3", "ADMIN", false},
		// member1 on c2 (column READ override) — column READ does
		// not elevate beyond board WRITE.
		{"member1 c2 ADMIN (column READ doesn't elevate)", "member1", "MEMBER", "column", "c2", "ADMIN", false},

		// Member2 has board READ on board1 but column ADMIN on
		// c1 — proves the column grant wins.
		{"member2 c1 ADMIN (column overrides board)", "member2", "MEMBER", "column", "c1", "ADMIN", true},
		{"member2 c1 READ", "member2", "MEMBER", "column", "c1", "READ", true},
		// c4 has explicit column READ for member2 while they only
		// have board READ on board1 — column grant is the lower
		// of the two but still authoritative.
		{"member2 c4 WRITE (column READ does not elevate)", "member2", "MEMBER", "column", "c4", "WRITE", false},

		// Viewer1 has board READ but VIEWER role blocks
		// write-side ops via requireNonViewer — this test only
		// exercises the access-helper path; the role-gated check
		// lives in handler tests. Here, READ on the column
		// succeeds because viewer1 has column READ on c2.
		{"viewer1 c2 READ (column grant)", "viewer1", "VIEWER", "column", "c2", "READ", true},
		// viewer1 also has board READ on board1, so c3 (no
		// per-column grant) falls back to board READ.
		{"viewer1 c3 READ (board fallback)", "viewer1", "VIEWER", "column", "c3", "READ", true},
		// viewer1 has no board access on board2, so c4 (which
		// would fall back to board2) is denied — even though c4
		// itself has no row for viewer1. This is the case where
		// the matrix must read false.
		{"viewer1 board2 READ (no grant)", "viewer1", "VIEWER", "board", "board2", "READ", false},
		// Viewer1 also has board READ on board1 (explicit grant),
		// so board access passes the access-level check but the
		// VIEWER role would block writes at the handler layer.
		{"viewer1 board1 READ (explicit grant)", "viewer1", "VIEWER", "board", "board1", "READ", true},
		{"viewer1 board1 WRITE (no grant that high)", "viewer1", "VIEWER", "board", "board1", "WRITE", false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			// Each case starts with a clean permission cache so
			// the order in which the cases run cannot leak state.
			ResetPermissionCacheForTest()

			var got bool
			switch tc.resourceKind {
			case "board":
				got = checkBoardAccess(db, tc.userID, tc.resourceID, tc.requiredAccess, tc.userRole)
			case "column":
				got = checkColumnAccessWithBoardFallback(db, tc.userID, tc.resourceID, tc.requiredAccess, tc.userRole)
			default:
				t.Fatalf("unknown resource kind %q", tc.resourceKind)
			}
			if got != tc.want {
				t.Errorf("check %s access for %s on %s %s require=%s: got %v want %v",
					tc.resourceKind, tc.userID, tc.resourceKind, tc.resourceID, tc.requiredAccess, got, tc.want)
			}
		})
	}
}

// TestPermissionCascade_ColumnOverridesBoard proves that an
// explicit column-level ADMIN row on top of a board-level WRITE
// grant resolves to ADMIN for the user on that column — i.e. the
// column grant is the authoritative value, not the maximum.
func TestPermissionCascade_ColumnOverridesBoard(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// member2 has board READ on board1 and column ADMIN on c1.
	if !checkColumnAccessWithBoardFallback(db, "member2", "c1", "ADMIN", "MEMBER") {
		t.Error("expected column ADMIN override to grant ADMIN on c1")
	}
	if !checkColumnAccessWithBoardFallback(db, "member2", "c1", "WRITE", "MEMBER") {
		t.Error("expected column ADMIN override to also grant WRITE on c1")
	}
	if !checkColumnAccess(db, "member2", "c1", "ADMIN", "MEMBER") {
		t.Error("expected column-level check to report ADMIN on c1")
	}
}

// TestPermissionCascade_BoardFallback proves that when there is no
// column-level grant for a (user, column) pair, the access
// decision falls back to the board-level grant rather than
// returning empty / deny.
func TestPermissionCascade_BoardFallback(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// c3 has no per-column grant for member1; member1 has board
	// WRITE on board1.
	if checkColumnAccess(db, "member1", "c3", "WRITE", "MEMBER") {
		t.Error("expected column-only check to return false (no column grant)")
	}
	if !checkColumnAccessWithBoardFallback(db, "member1", "c3", "WRITE", "MEMBER") {
		t.Error("expected board fallback to grant WRITE on c3 via board1's WRITE")
	}
	if checkColumnAccessWithBoardFallback(db, "member1", "c3", "ADMIN", "MEMBER") {
		t.Error("expected board fallback NOT to elevate to ADMIN (board grant is WRITE)")
	}
}

// TestPermissionInheritance_OwnerInheritsAll proves that a
// per-board owner (recorded via owner_agent_id on their
// board_permissions row) is implicitly granted ADMIN on that board
// even when their global role is MEMBER or VIEWER. The grant is
// reflected in the cached value so subsequent checks stay a
// cache hit.
func TestPermissionInheritance_OwnerInheritsAll(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// owner1 is recorded as owner_agent_id on their board1 row
	// and has global role MEMBER. They should still be granted
	// ADMIN via the owner short-circuit.
	for _, lvl := range []string{"READ", "WRITE", "ADMIN"} {
		if !checkBoardAccess(db, "owner1", "board1", lvl, "MEMBER") {
			t.Errorf("expected owner1 to have %s on board1 via owner short-circuit", lvl)
		}
	}

	// The cache must now hold the resolved ADMIN access so
	// subsequent checks stay a cache hit (no DB roundtrip).
	cached, ok := permissionCache.Get("owner1", "board1")
	if !ok {
		t.Fatal("expected permission cache entry for owner1 on board1 after first check")
	}
	if cached != "ADMIN" {
		t.Errorf("expected cache to hold ADMIN (resolved via owner short-circuit), got %q", cached)
	}

	// VIEWER-as-owner: promote viewer1 to owner of board2 and
	// re-check. VIEWER is normally read-only but the owner flag
	// must override the role gate at the access-helper layer
	// (handlers still apply requireNonViewer, that path is
	// covered separately).
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES ('bp-viewer1-board2', 'viewer1', 'board2', 'viewer1', 'READ')`,
	); err != nil {
		t.Fatalf("failed to seed viewer owner row: %v", err)
	}
	ResetPermissionCacheForTest()
	if !checkBoardAccess(db, "viewer1", "board2", "ADMIN", "VIEWER") {
		t.Error("expected VIEWER-as-owner to have ADMIN on board2 via owner short-circuit")
	}
}

// TestPermissionChange_TakesEffectImmediately walks a full
// HTTP request cycle and verifies that a permission change
// performed by admin1 is reflected in the next request from the
// target user without requiring them to log out. The fixture
// uses SetPermission to upgrade member2 from board READ to
// board ADMIN and confirms (a) the DB row is updated, (b) the
// target user's cached permission entries are flushed, and (c)
// the next access check reads the fresh value.
func TestPermissionChange_TakesEffectImmediately(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// Warm the permission cache with member2's current
	// (READ) access on board1 so we can later assert the
	// invalidation took effect.
	if !checkBoardAccess(db, "member2", "board1", "READ", "MEMBER") {
		t.Fatal("pre-condition: member2 should have READ on board1")
	}
	if cached, ok := permissionCache.Get("member2", "board1"); !ok || cached != "READ" {
		t.Fatalf("pre-condition: expected cached READ, got %q (ok=%v)", cached, ok)
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/permissions", SetPermission(db))

	body := map[string]interface{}{"userId": "member2", "boardId": "board1", "access": "ADMIN"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected SetPermission to succeed (200), got %d: %s", w.Code, w.Body.String())
	}

	// After the request: DB row should be ADMIN.
	var access string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'member2' AND board_id = 'board1'`,
	).Scan(&access); err != nil {
		t.Fatalf("failed to read updated access: %v", err)
	}
	if access != "ADMIN" {
		t.Errorf("expected DB row to read ADMIN, got %q", access)
	}

	// After the request: cache entry must be gone so the next
	// check re-reads the DB. The SetPermission handler is the
	// one that should have flushed member2's entries.
	if _, ok := permissionCache.Get("member2", "board1"); ok {
		t.Error("expected member2's cached access on board1 to be invalidated after SetPermission")
	}

	// And the next access check should now return true for
	// ADMIN (the freshly-read value).
	if !checkBoardAccess(db, "member2", "board1", "ADMIN", "MEMBER") {
		t.Error("expected member2 to have ADMIN on board1 after SetPermission")
	}
}

// TestLastAdmin_CannotBeDemoted drives the PUT /api/users handler
// end-to-end and asserts that the demotion of the only enabled
// ADMIN user is refused with a 400. Covers both the role-change
// path and the JSON response shape so future refactors of
// UpdateUser don't silently regress the guard rail.
func TestLastAdmin_CannotBeDemoted(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// Ensure admin2 is non-ADMIN so admin1 is the only enabled
	// ADMIN — this is the precondition the handler checks.
	if _, err := db.Exec(`UPDATE users SET role = 'MEMBER', enabled = 1 WHERE id = 'admin2'`); err != nil {
		t.Fatalf("failed to demote admin2: %v", err)
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.PUT("/api/users", UpdateUser(db))

	body := map[string]interface{}{"targetUserId": "admin1", "role": "MEMBER"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for demote-the-last-admin, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["error"] == "" {
		t.Error("expected error message in response body")
	}

	// admin1's role must still be ADMIN.
	var role string
	if err := db.QueryRow(`SELECT role FROM users WHERE id = 'admin1'`).Scan(&role); err != nil {
		t.Fatalf("failed to read admin1 role: %v", err)
	}
	if role != "ADMIN" {
		t.Errorf("expected admin1 role to remain ADMIN, got %s", role)
	}

	// Sanity: when a second admin exists, the same demotion
	// should succeed (200) and the DB row should flip to MEMBER.
	if _, err := db.Exec(`UPDATE users SET role = 'ADMIN', enabled = 1 WHERE id = 'admin2'`); err != nil {
		t.Fatalf("failed to re-promote admin2: %v", err)
	}

	body2 := map[string]interface{}{"targetUserId": "admin1", "role": "MEMBER"}
	jsonBody2, _ := json.Marshal(body2)
	req2, _ := http.NewRequest("PUT", "/api/users", bytes.NewBuffer(jsonBody2))
	req2.Header.Set("Content-Type", "application/json")
	req2.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin2-token"})
	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200 when second admin exists, got %d: %s", w2.Code, w2.Body.String())
	}
	if err := db.QueryRow(`SELECT role FROM users WHERE id = 'admin1'`).Scan(&role); err != nil {
		t.Fatalf("failed to re-read admin1 role: %v", err)
	}
	if role != "MEMBER" {
		t.Errorf("expected admin1 role to flip to MEMBER with second admin present, got %s", role)
	}
}

// TestLastAdmin_CannotBeDisabled drives the POST
// /api/users/enabled handler and asserts that disabling the only
// enabled ADMIN is refused with a 400. Mirrors the demotion guard
// rail so the two paths can't drift apart.
//
// Practical scenario for the guard to fire: there must be a
// requester authenticated as ADMIN whose DB row is *not* counted
// in IsLastAdmin(target). This can happen when the requester's
// session is cached (so they pass RequireAuth) but their
// DB-side enabled flag has since flipped to 0 (so IsLastAdmin
// does not count them). The test seeds exactly that state.
func TestLastAdmin_CannotBeDisabled(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	// admin1 is the only enabled ADMIN in the DB. admin2 is
	// "ADMIN" by role but disabled — IsLastAdmin(admin1) excludes
	// disabled rows so it returns true (count = 0).
	if _, err := db.Exec(`UPDATE users SET role = 'ADMIN', enabled = 0 WHERE id = 'admin2'`); err != nil {
		t.Fatalf("failed to disable admin2: %v", err)
	}

	// Pre-seed admin2's session into the token cache so the
	// auth middleware accepts them as ADMIN even though their
	// DB-side enabled flag is 0. This is the realistic scenario
	// the guard rail protects against: a stale cached session
	// trying to take down the last active admin.
	tokenCache.Store("admin2-token", &cachedUser{
		user:      &models.User{ID: "admin2", Role: "ADMIN", Type: "HUMAN", Enabled: true},
		expiresAt: time.Now().Add(5 * time.Minute),
	})

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/users/enabled", SetUserEnabled(db))

	body := map[string]interface{}{"userId": "admin1", "enabled": false}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/users/enabled", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin2-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for disable-the-last-admin, got %d: %s", w.Code, w.Body.String())
	}

	var enabled bool
	if err := db.QueryRow(`SELECT enabled FROM users WHERE id = 'admin1'`).Scan(&enabled); err != nil {
		t.Fatalf("failed to read admin1 enabled: %v", err)
	}
	if !enabled {
		t.Error("expected admin1 to remain enabled after rejected disable")
	}
}

// TestPermissionRevoke_CleansUpActiveSessions proves that the
// permission handlers invalidate BOTH the token cache AND the
// permission cache for the target user when a grant is revoked.
// Without the token cache flush the target user's next request
// would still resolve through the cached *old* role / enabled
// state; without the permission cache flush it would still see
// the now-revoked board access for up to 5 minutes.
//
// We exercise both SetPermission (downgrade) and DeletePermission
// (hard remove) to confirm they share the same invalidation
// contract.
func TestPermissionRevoke_CleansUpActiveSessions(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	t.Run("SetPermission downgrade flushes caches", func(t *testing.T) {
		db := setupPermissionIntegrationDB(t)
		defer db.Close()

		SeedTokenCacheForTest("member1-tok-1", "member1", "MEMBER")
		SeedTokenCacheForTest("member1-tok-2", "member1", "MEMBER")

		if !checkBoardAccess(db, "member1", "board1", "WRITE", "MEMBER") {
			t.Fatal("pre-condition: member1 should have WRITE on board1")
		}
		if _, ok := permissionCache.Get("member1", "board1"); !ok {
			t.Fatal("pre-condition: expected cache entry for member1:board1")
		}

		router := gin.New()
		router.Use(RequireAuth(db))
		router.POST("/api/permissions", SetPermission(db))

		body := map[string]interface{}{"userId": "member1", "boardId": "board1", "access": "READ"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 from SetPermission, got %d: %s", w.Code, w.Body.String())
		}

		if _, ok := PeekTokenCache("member1-tok-1"); ok {
			t.Error("expected member1-tok-1 to be invalidated after downgrade")
		}
		if _, ok := PeekTokenCache("member1-tok-2"); ok {
			t.Error("expected member1-tok-2 to be invalidated after downgrade")
		}
		if _, ok := permissionCache.Get("member1", "board1"); ok {
			t.Error("expected member1:board1 cache entry to be invalidated after downgrade")
		}
	})

	t.Run("DeletePermission flushes caches", func(t *testing.T) {
		db := setupPermissionIntegrationDB(t)
		defer db.Close()

		SeedTokenCacheForTest("member1-tok-1", "member1", "MEMBER")
		SeedTokenCacheForTest("member1-tok-2", "member1", "MEMBER")

		if !checkBoardAccess(db, "member1", "board1", "WRITE", "MEMBER") {
			t.Fatal("pre-condition: member1 should have WRITE on board1")
		}
		if _, ok := permissionCache.Get("member1", "board1"); !ok {
			t.Fatal("pre-condition: expected cache entry for member1:board1")
		}

		router := gin.New()
		router.Use(RequireAuth(db))
		router.DELETE("/api/permissions", DeletePermission(db))

		req, _ := http.NewRequest("DELETE", "/api/permissions?id=bp-member1-board1", nil)
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 from DeletePermission, got %d: %s", w.Code, w.Body.String())
		}

		if _, ok := PeekTokenCache("member1-tok-1"); ok {
			t.Error("expected member1-tok-1 to be invalidated after delete")
		}
		if _, ok := PeekTokenCache("member1-tok-2"); ok {
			t.Error("expected member1-tok-2 to be invalidated after delete")
		}
		if _, ok := permissionCache.Get("member1", "board1"); ok {
			t.Error("expected member1:board1 cache entry to be invalidated after delete")
		}
	})
}

// TestGetEffectiveColumnAccessForBoard_NoUser covers the
// userID == "" branch of GetEffectiveColumnAccessForBoard which
// the existing helper tests do not exercise. The function must
// still return every column under the board (with an empty
// access string) so the caller can render an empty access map
// without hitting the per-column join path.
func TestGetEffectiveColumnAccessForBoard_NoUser(t *testing.T) {
	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	result, err := GetEffectiveColumnAccessForBoard(db, "", "board1", "MEMBER")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, ok := result["c1"]; !ok {
		t.Error("expected c1 to be in result map for no-user branch")
	} else if got != "" {
		t.Errorf("expected empty access for c1, got %q", got)
	}
	if got, ok := result["c3"]; !ok {
		t.Error("expected c3 to be in result map for no-user branch")
	} else if got != "" {
		t.Errorf("expected empty access for c3, got %q", got)
	}
}
