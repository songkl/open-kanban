package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// setupUsersVisibleDB seeds a focused fixture for the
// /api/v1/auth/users-visible tests (s-1038):
//
//	admin1    (ADMIN HUMAN, token=admin-token)
//	member1   (MEMBER HUMAN, token=member1-token) — owns board1
//	member2   (MEMBER HUMAN, token=member2-token) — ADMIN row on board1
//	viewer1   (VIEWER HUMAN, token=viewer-token) — READ row on board1
//	invitee1  (MEMBER HUMAN, no board_permissions row at all)
//	board1    owned by member1; admin1/member2/viewer1 already granted
//	board2    owned by admin1; empty
//
// member1 is a MEMBER-as-owner so the "non-admin owner can call"
// path is exercised end-to-end. member2 carries a per-board ADMIN
// row granted by admin1 — important so the test for "non-owner
// non-admin" can use them: they have an ADMIN row but no
// owner_agent_id stamp, so canManageBoardPermissions must deny
// them.
func setupUsersVisibleDB(t *testing.T) *sql.DB {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
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
		type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
		role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
		UNIQUE(user_id, board_id),
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	for _, u := range []struct{ id, nick, role string }{
		{"admin1", "Admin One", "ADMIN"},
		{"member1", "Member One", "MEMBER"},
		{"member2", "Member Two", "MEMBER"},
		{"viewer1", "Viewer One", "VIEWER"},
		{"invitee1", "Invitee One", "MEMBER"},
	} {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', ?, 1, '', 'HUMAN')`,
			u.id, u.id, u.nick, u.role,
		); err != nil {
			t.Fatalf("failed to seed user %s: %v", u.id, err)
		}
	}

	for _, tok := range []struct{ id, user, key string }{
		{"token-admin", "admin1", "admin-token"},
		{"token-member1", "member1", "member1-token"},
		{"token-member2", "member2", "member2-token"},
		{"token-viewer", "viewer1", "viewer-token"},
		{"token-invitee1", "invitee1", "invitee1-token"},
	} {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("failed to seed token %s: %v", tok.id, err)
		}
	}

	if _, err := db.Exec(
		`INSERT INTO boards (id, name) VALUES ('board1', 'Board One'), ('board2', 'Board Two')`,
	); err != nil {
		t.Fatalf("seed boards: %v", err)
	}

	// board1: owned by member1, three explicit grants.
	rows := []struct {
		id, user, board, owner, access string
	}{
		{"bp-member1-board1", "member1", "board1", "member1", "ADMIN"},
		{"bp-admin-board1", "admin1", "board1", "", "ADMIN"},
		{"bp-member2-board1", "member2", "board1", "", "ADMIN"},
		{"bp-viewer-board1", "viewer1", "board1", "", "READ"},
		// board2 owned by admin1 — used by the global-admin
		// test (member2 is a candidate since they have no row on
		// board2 at all).
		{"bp-admin-board2", "admin1", "board2", "admin1", "ADMIN"},
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
			t.Fatalf("seed perm %s: %v", r.id, err)
		}
	}

	return db
}

// callUsersVisible issues a GET against the /api/v1/auth/users-visible
// endpoint as the named token holder, with the supplied query
// string. Returns the recorder so callers can inspect status / body.
func callUsersVisible(t *testing.T, db *sql.DB, token, query string) *httptest.ResponseRecorder {
	t.Helper()
	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/auth/users-visible", GetUsersVisible(db))

	url := "/api/v1/auth/users-visible"
	if query != "" {
		url += "?" + query
	}
	req, _ := http.NewRequest("GET", url, nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// TestGetUsersVisible_NonAdminOwnerCanCall guards the central
// promise of s-1038: a MEMBER who owns the board can list
// candidate collaborators for the AddBoardPermissionForm. This is
// the scenario that broke under the old getUsers()-only flow.
func TestGetUsersVisible_NonAdminOwnerCanCall(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "member1-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to call endpoint (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Users []struct {
			UserID   string `json:"userId"`
			Username string `json:"username"`
			Nickname string `json:"nickname"`
			Type     string `json:"type"`
			Role     string `json:"role"`
		} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	// Visible candidates on board1: invitee1 has no row; everyone
	// else (admin1 / member1 / member2 / viewer1) has an
	// effective grant and must be filtered out.
	got := make(map[string]bool, len(resp.Users))
	for _, u := range resp.Users {
		got[u.UserID] = true
	}

	if !got["invitee1"] {
		t.Errorf("expected invitee1 in visible list (no row on board1), got %v", got)
	}
	for _, hidden := range []string{"admin1", "member1", "member2", "viewer1"} {
		if got[hidden] {
			t.Errorf("expected %s to be excluded (already has effective access), got %v", hidden, got)
		}
	}
	if len(resp.Users) != 1 {
		t.Errorf("expected exactly 1 visible user, got %d: %v", len(resp.Users), got)
	}

	invitee := resp.Users[0]
	if invitee.Username != "invitee1" {
		t.Errorf("expected username=invitee1, got %q", invitee.Username)
	}
	if invitee.Type != "HUMAN" {
		t.Errorf("expected type=HUMAN, got %q", invitee.Type)
	}
	if invitee.Role != "MEMBER" {
		t.Errorf("expected role=MEMBER, got %q", invitee.Role)
	}
}

// TestGetUsersVisible_NonOwnerNonAdmin_Returns403 covers the
// negative half: a MEMBER with an ADMIN row but no owner stamp
// cannot enumerate visible users. canManageBoardPermissions must
// deny them — the same rule SetPermission / DeletePermission
// enforce.
func TestGetUsersVisible_NonOwnerNonAdmin_Returns403(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	// member2 has an ADMIN row on board1 but is NOT the owner.
	w := callUsersVisible(t, db, "member2-token", "boardId=board1")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}

	// viewer1 has only a READ row — even more clearly not
	// authorized.
	w = callUsersVisible(t, db, "viewer-token", "boardId=board1")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for VIEWER, got %d: %s", w.Code, w.Body.String())
	}

	// A member with no row on the board at all: invitee1 is
	// only seeded on board2 indirectly (no row there either),
	// but more importantly they have no claim on board1.
	w = callUsersVisible(t, db, "invitee1-token", "boardId=board1")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for user with no permission at all, got %d: %s", w.Code, w.Body.String())
	}
}

// TestGetUsersVisible_GlobalAdminWithoutBoardID verifies the
// admin-only "list everyone" mode. The endpoint must NOT require
// a boardId when the caller is a global ADMIN, and must return
// every user so the existing getUsers()-based pickers still work.
func TestGetUsersVisible_GlobalAdminWithoutBoardID(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "admin-token", "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected admin to list users without boardId (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Users []struct {
			UserID   string `json:"userId"`
			Username string `json:"username"`
			Nickname string `json:"nickname"`
			Type     string `json:"type"`
			Role     string `json:"role"`
		} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	ids := make(map[string]bool, len(resp.Users))
	for _, u := range resp.Users {
		ids[u.UserID] = true
	}

	for _, expected := range []string{"admin1", "member1", "member2", "viewer1", "invitee1"} {
		if !ids[expected] {
			t.Errorf("expected user %q in admin-visible list, got %v", expected, ids)
		}
	}
	if len(resp.Users) != 5 {
		t.Errorf("expected 5 users in admin-visible list, got %d", len(resp.Users))
	}
}

// TestGetUsersVisible_NonAdminWithoutBoardID_Returns403 guards
// the inverse: when boardId is missing and the caller is not a
// global admin, the endpoint must reject with 403 instead of
// leaking the entire user list.
func TestGetUsersVisible_NonAdminWithoutBoardID_Returns403(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "member1-token", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-admin without boardId, got %d: %s", w.Code, w.Body.String())
	}

	w = callUsersVisible(t, db, "viewer-token", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for VIEWER without boardId, got %d: %s", w.Code, w.Body.String())
	}
}

// TestGetUsersVisible_GlobalAdminWithBoardID confirms admins can
// also pass a boardId — they short-circuit the authorization
// branch and the candidate list is filtered the same way it is
// for owners. This covers the "operator scopes their picker to a
// single board" workflow without going through the getUsers()
// admin-only path.
func TestGetUsersVisible_GlobalAdminWithBoardID(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected admin to scope to board1 (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Users []struct {
			UserID string `json:"userId"`
		} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	got := make(map[string]bool, len(resp.Users))
	for _, u := range resp.Users {
		got[u.UserID] = true
	}

	// invitee1 is the only candidate — admin1/member1/member2/viewer1
	// all have effective access on board1.
	if !got["invitee1"] {
		t.Errorf("expected invitee1 in admin-visible list scoped to board1, got %v", got)
	}
	for _, hidden := range []string{"admin1", "member1", "member2", "viewer1"} {
		if got[hidden] {
			t.Errorf("expected %s excluded on board1, got %v", hidden, got)
		}
	}
}

// TestGetUsersVisible_ExcludesExistingPermissionHolders is the
// focused regression guard for the "left join isolates from
// existing permission holders" requirement. The fixture has
// every user except invitee1 already holding an explicit grant
// on board1 — invitee1 must be the lone survivor in the response.
func TestGetUsersVisible_ExcludesExistingPermissionHolders(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Users []map[string]interface{} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(resp.Users) != 1 {
		t.Fatalf("expected exactly 1 visible user, got %d: %v", len(resp.Users), resp.Users)
	}

	only := resp.Users[0]
	if only["userId"] != "invitee1" {
		t.Errorf("expected userId=invitee1, got %v", only["userId"])
	}
	// Spot-check the response shape: every documented field is
	// present and non-empty.
	for _, key := range []string{"userId", "username", "nickname", "type", "role"} {
		if only[key] == "" || only[key] == nil {
			t.Errorf("expected %q in response payload, got %v", key, only)
		}
	}
}

// TestGetUsersVisible_IncludesExpiredAndRevokedHolders verifies
// the expires_at / revoked_at contract: a row whose access has
// expired (expires_at in the past) or been soft-deleted
// (revoked_at set) does NOT count as effective access, so the
// user is re-included in the visible list. This is the
// s-1101 interlock called out in the task description.
func TestGetUsersVisible_IncludesExpiredAndRevokedHolders(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	// Add two more users with rows that look like real grants
	// but are no longer effective. Both must show up in the
	// visible list because their rows are either expired or
	// revoked.
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('expired1', 'expired1', 'Expired One', 'pass', 'MEMBER', 1, '', 'HUMAN')`,
	); err != nil {
		t.Fatalf("seed expired1: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('revoked1', 'revoked1', 'Revoked One', 'pass', 'MEMBER', 1, '', 'HUMAN')`,
	); err != nil {
		t.Fatalf("seed revoked1: %v", err)
	}

	// expired1: row with expires_at in the past.
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, access, expires_at) VALUES ('bp-expired1', 'expired1', 'board1', 'READ', datetime('now', '-1 day'))`,
	); err != nil {
		t.Fatalf("seed expired row: %v", err)
	}
	// revoked1: row with revoked_at set (soft-deleted).
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, access, revoked_at) VALUES ('bp-revoked1', 'revoked1', 'board1', 'WRITE', datetime('now'))`,
	); err != nil {
		t.Fatalf("seed revoked row: %v", err)
	}

	w := callUsersVisible(t, db, "member1-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to call endpoint (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Users []struct {
			UserID string `json:"userId"`
		} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	got := make(map[string]bool, len(resp.Users))
	for _, u := range resp.Users {
		got[u.UserID] = true
	}

	// Both expired1 and revoked1 must reappear because their
	// rows are not effective; invitee1 stays in because they
	// never had a row at all.
	for _, expected := range []string{"expired1", "revoked1", "invitee1"} {
		if !got[expected] {
			t.Errorf("expected %s in visible list (no effective access), got %v", expected, got)
		}
	}
	for _, hidden := range []string{"admin1", "member1", "member2", "viewer1"} {
		if got[hidden] {
			t.Errorf("expected %s excluded (effective access), got %v", hidden, got)
		}
	}
}

// TestGetUsersVisible_BoardNotFound_Returns404 confirms a
// well-formed authorization call against a non-existent board
// returns 404 — the handler must surface the missing-board
// case distinctly from the 403 it returns for unauthorized
// callers.
func TestGetUsersVisible_BoardNotFound_Returns404(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "admin-token", "boardId=ghost-board")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent board, got %d: %s", w.Code, w.Body.String())
	}
}

// TestGetUsersVisible_Unauthenticated_Returns401 covers the
// baseline auth gate: any caller without a valid token gets 401
// before the authorization branches run.
func TestGetUsersVisible_Unauthenticated_Returns401(t *testing.T) {
	db := setupUsersVisibleDB(t)
	defer db.Close()

	w := callUsersVisible(t, db, "", "boardId=board1")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated request, got %d: %s", w.Code, w.Body.String())
	}

	w = callUsersVisible(t, db, "", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated admin-mode request, got %d: %s", w.Code, w.Body.String())
	}
}
