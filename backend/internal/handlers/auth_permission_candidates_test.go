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

// setupPermissionsCandidatesDB seeds a fixture targeting the
// candidates extension of GET /api/v1/auth/permissions (s-1039):
//
//	admin1    (ADMIN HUMAN) — owns board1 via owner_agent_id
//	member1   (MEMBER HUMAN) — WRITE row on board1 (no owner stamp)
//	member2   (MEMBER HUMAN) — ADMIN row on board1 (no owner stamp)
//	viewer1   (VIEWER HUMAN) — READ row on board1
//	invitee1  (MEMBER HUMAN) — no row on board1 at all
//	expired1  (MEMBER HUMAN) — READ row with expires_at in the past
//	revoked1  (MEMBER HUMAN) — WRITE row with revoked_at set
//	board1    owned by admin1
//
// admin1 is the owner (so canManageBoardPermissions returns true)
// and is therefore expected to be EXCLUDED from the candidates
// list. invitee1, expired1 and revoked1 are the only users that
// should show up.
func setupPermissionsCandidatesDB(t *testing.T) *sql.DB {
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
		{"expired1", "Expired One", "MEMBER"},
		{"revoked1", "Revoked One", "MEMBER"},
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
		{"token-member", "member1", "member1-token"},
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
		`INSERT INTO boards (id, name) VALUES ('board1', 'Board One')`,
	); err != nil {
		t.Fatalf("seed board1: %v", err)
	}

	rows := []struct {
		id, user, board, owner, access string
		expiresAt, revokedAt           interface{}
	}{
		{"bp-admin-board1", "admin1", "board1", "admin1", "ADMIN", nil, nil},
		{"bp-member1-board1", "member1", "board1", "", "WRITE", nil, nil},
		{"bp-member2-board1", "member2", "board1", "", "ADMIN", nil, nil},
		{"bp-viewer-board1", "viewer1", "board1", "", "READ", nil, nil},
		{"bp-expired1-board1", "expired1", "board1", "", "READ", "datetime('now', '-1 day')", nil},
		{"bp-revoked1-board1", "revoked1", "board1", "", "WRITE", nil, "datetime('now')"},
	}
	for _, r := range rows {
		var ownerArg interface{}
		if r.owner != "" {
			ownerArg = r.owner
		}
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, `+nullableExpr(r.expiresAt)+`, `+nullableExpr(r.revokedAt)+`)`,
			r.id, r.user, r.board, ownerArg, r.access,
		); err != nil {
			t.Fatalf("seed perm %s: %v", r.id, err)
		}
	}

	return db
}

// nullableExpr returns "NULL" when the value is nil so the seed
// INSERT can be a single fixed-width statement. A non-nil value
// like "datetime('now', '-1 day')" is inlined verbatim — the seed
// rows are constrained to SQLite expressions so we keep the test
// DB driver portable.
func nullableExpr(v interface{}) string {
	if v == nil {
		return "NULL"
	}
	return v.(string)
}

// callGetPermissions exercises GET /api/v1/auth/permissions with
// the supplied token and query string. Returns the recorder so
// callers can inspect status / body.
func callGetPermissions(t *testing.T, db *sql.DB, token, query string) *httptest.ResponseRecorder {
	t.Helper()
	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/auth/permissions", GetPermissions(db))

	url := "/api/v1/auth/permissions"
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

// TestGetPermissions_CandidatesExcludesOwnerAndExistingHolders is
// the central promise of s-1039: an owner calling
// GET /api/v1/auth/permissions?boardId=board1 receives the
// existing permissions list AND a candidates array containing
// exactly the users who do NOT yet hold effective access — i.e.
// the "who can I still invite" picker for the permission
// management UI.
//
// The fixture has:
//   - admin1 owning board1 → owner, must be excluded
//   - member1/member2/viewer1 holding READ/WRITE/ADMIN rows →
//     must be excluded
//   - invitee1 / expired1 / revoked1 without effective access →
//     must be included
func TestGetPermissions_CandidatesExcludesOwnerAndExistingHolders(t *testing.T) {
	db := setupPermissionsCandidatesDB(t)
	defer db.Close()

	w := callGetPermissions(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to call endpoint (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Permissions []map[string]interface{} `json:"permissions"`
		Candidates  []map[string]interface{} `json:"candidates"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp.Candidates == nil {
		t.Fatalf("expected non-nil candidates array, got nil")
	}

	got := make(map[string]bool, len(resp.Candidates))
	for _, c := range resp.Candidates {
		if id, ok := c["userId"].(string); ok {
			got[id] = true
		}
	}

	for _, expected := range []string{"invitee1", "expired1", "revoked1"} {
		if !got[expected] {
			t.Errorf("expected %s in candidates (no effective access), got %v", expected, got)
		}
	}
	for _, excluded := range []string{"admin1", "member1", "member2", "viewer1"} {
		if got[excluded] {
			t.Errorf("expected %s excluded from candidates (effective access or owner), got %v", excluded, got)
		}
	}
	if len(resp.Candidates) != 3 {
		t.Errorf("expected exactly 3 candidates, got %d: %v", len(resp.Candidates), got)
	}

	// Spot-check the response shape: every documented field is
	// present and non-empty for each candidate.
	for _, c := range resp.Candidates {
		for _, key := range []string{"userId", "username", "nickname", "type", "role"} {
			if c[key] == "" || c[key] == nil {
				t.Errorf("expected %q in candidate payload, got %v", key, c)
			}
		}
	}

	// The original `permissions` field must still be present
	// and non-empty — this is the backwards-compat guarantee.
	if resp.Permissions == nil {
		t.Fatalf("expected permissions field to remain present (backwards compat), got nil")
	}
	if len(resp.Permissions) == 0 {
		t.Fatalf("expected non-empty permissions list, got 0")
	}
}

// TestGetPermissions_CandidatesShapeMatchesUsersVisible guards
// the contract that candidates use the same JSON shape as the
// /api/v1/auth/users-visible endpoint — same field names, same
// types — so the frontend can reuse the same picker component
// without translation.
func TestGetPermissions_CandidatesShapeMatchesUsersVisible(t *testing.T) {
	db := setupPermissionsCandidatesDB(t)
	defer db.Close()

	w := callGetPermissions(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var raw struct {
		Candidates []map[string]interface{} `json:"candidates"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(raw.Candidates) == 0 {
		t.Fatalf("expected candidates array populated, got empty")
	}

	// The shape must match what /api/v1/auth/users-visible
	// returns: {userId, username, nickname, type, role}. No
	// extra or missing keys.
	only := raw.Candidates[0]
	wantKeys := map[string]bool{
		"userId":   true,
		"username": true,
		"nickname": true,
		"type":     true,
		"role":     true,
	}
	for k := range wantKeys {
		if _, ok := only[k]; !ok {
			t.Errorf("expected key %q in candidate payload, got keys %v", k, only)
		}
	}
	for k := range only {
		if !wantKeys[k] {
			t.Errorf("unexpected key %q in candidate payload, got keys %v", k, only)
		}
	}
}

// TestGetPermissions_CandidatesAbsentWithoutBoardID confirms the
// candidates field is only emitted when the request is scoped
// to a single board. A user-scoped or unscoped call must keep
// the old single-key response shape (only `permissions`) so
// callers parsing the historical response don't break.
func TestGetPermissions_CandidatesAbsentWithoutBoardID(t *testing.T) {
	db := setupPermissionsCandidatesDB(t)
	defer db.Close()

	w := callGetPermissions(t, db, "admin-token", "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	body := map[string]json.RawMessage{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if _, ok := body["candidates"]; ok {
		t.Errorf("expected no candidates key on unscoped request, got body=%s", w.Body.String())
	}
	if _, ok := body["permissions"]; !ok {
		t.Errorf("expected permissions key on unscoped request, got body=%s", w.Body.String())
	}
}

// TestGetPermissions_CandidatesEmptyArrayIsArray guards the
// "always return [] instead of null" promise from the API style
// guide. The implementation initializes candidates to an empty
// slice so JSON encodes [] rather than null, even when the
// query itself returns zero rows.
func TestGetPermissions_CandidatesEmptyArrayIsArray(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
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
		t.Fatalf("schema: %v", err)
	}

	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('admin1', 'admin1', 'Admin', 'pass', 'ADMIN', 1, '', 'HUMAN')`,
	); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tokens (id, name, key, user_id) VALUES ('token-admin', 'default', 'admin-token', 'admin1')`,
	); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO boards (id, name) VALUES ('board1', 'Board One')`,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	// admin1 owns board1 — no other users exist, so candidates
	// must be empty.
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES ('bp-admin-board1', 'admin1', 'board1', 'admin1', 'ADMIN')`,
	); err != nil {
		t.Fatalf("seed perm: %v", err)
	}

	w := callGetPermissions(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if !bodyContains(w.Body.String(), `"candidates":[]`) {
		t.Errorf("expected candidates to encode as [] (not null), got body=%s", w.Body.String())
	}
}

// TestGetPermissions_CandidatesRespectsExpiryAndRevocation is
// the focused regression guard for the s-1101 interlock called
// out in the task description. A row whose access has expired
// (expires_at in the past) or been soft-deleted (revoked_at set)
// does NOT count as effective access — those users must reappear
// in candidates.
func TestGetPermissions_CandidatesRespectsExpiryAndRevocation(t *testing.T) {
	db := setupPermissionsCandidatesDB(t)
	defer db.Close()

	w := callGetPermissions(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Candidates []struct {
			UserID string `json:"userId"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	got := make(map[string]bool, len(resp.Candidates))
	for _, c := range resp.Candidates {
		got[c.UserID] = true
	}

	if !got["expired1"] {
		t.Errorf("expected expired1 in candidates (expires_at in past), got %v", got)
	}
	if !got["revoked1"] {
		t.Errorf("expected revoked1 in candidates (revoked_at set), got %v", got)
	}
}

// bodyContains is a tiny helper used by tests that need to assert
// on the raw JSON body for keys like "candidates":[] (which
// decode into nil slices but still appear verbatim in the
// body).
func bodyContains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
