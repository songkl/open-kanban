package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// setupUnifiedPermissionsDB seeds a fixture for the s-1041
// unified-response-shape tests. The schema mirrors the production
// board_permissions layout after migration 008 (audit columns
// present and nullable).
//
// Seeds:
//
//	admin1   (ADMIN HUMAN) — owns board1 via owner_agent_id
//	member1  (MEMBER HUMAN) — WRITE row on board1, granted_by=admin1
//	member2  (MEMBER HUMAN) — READ row on board1, granted_by=admin1
//	viewer1  (VIEWER HUMAN) — READ row on board1, granted_by=admin1
//	expired1 (MEMBER HUMAN) — WRITE row on board1 with expires_at in the past
//	board1   owned by admin1
//	board2   no permission rows (for ?boardId= negative tests)
func setupUnifiedPermissionsDB(t *testing.T) *sql.DB {
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

	users := []struct {
		id, nick, role string
	}{
		{"admin1", "Admin One", "ADMIN"},
		{"member1", "Member One", "MEMBER"},
		{"member2", "Member Two", "MEMBER"},
		{"viewer1", "Viewer One", "VIEWER"},
		{"expired1", "Expired One", "MEMBER"},
	}
	for _, u := range users {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', ?, 1, '', 'HUMAN')`,
			u.id, u.id, u.nick, u.role,
		); err != nil {
			t.Fatalf("seed user %s: %v", u.id, err)
		}
	}

	tokens := []struct {
		id, user, key string
	}{
		{"token-admin", "admin1", "admin-token"},
		{"token-member", "member1", "member1-token"},
		{"token-viewer", "viewer1", "viewer-token"},
	}
	for _, tok := range tokens {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("seed token %s: %v", tok.id, err)
		}
	}

	boards := []struct{ id, name string }{
		{"board1", "Board One"},
		{"board2", "Board Two"},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name) VALUES (?, ?)`,
			b.id, b.name,
		); err != nil {
			t.Fatalf("seed board %s: %v", b.id, err)
		}
	}

	// member1 / member2 / viewer1 / expired1 each get a row on
	// board1. admin1's row uses owner_agent_id = admin1 to mark
	// ownership. member1/member2/viewer1 were granted by admin1
	// (granted_by_user_id = admin1); expired1's row has
	// expires_at in the past to exercise the audit-field
	// projection.
	rows := []struct {
		id, user, board, owner, access, grantedBy string
		expiresAt, revokedAt                       interface{}
	}{
		{"bp-admin", "admin1", "board1", "admin1", "ADMIN", "admin1", nil, nil},
		{"bp-member1", "member1", "board1", "", "WRITE", "admin1", nil, nil},
		{"bp-member2", "member2", "board1", "", "READ", "admin1", nil, nil},
		{"bp-viewer1", "viewer1", "board1", "", "READ", "admin1", nil, nil},
		{"bp-expired1", "expired1", "board1", "", "WRITE", "admin1", "datetime('now', '-1 hour')", nil},
	}
	for _, r := range rows {
		var ownerArg, grantedByArg interface{}
		if r.owner != "" {
			ownerArg = r.owner
		}
		if r.grantedBy != "" {
			grantedByArg = r.grantedBy
		}
		if _, err := db.Exec(
			`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, granted_by_user_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, `+nullableExpr(r.expiresAt)+`, `+nullableExpr(r.revokedAt)+`)`,
			r.id, r.user, r.board, ownerArg, r.access, grantedByArg,
		); err != nil {
			t.Fatalf("seed perm %s: %v", r.id, err)
		}
	}

	return db
}

// permissionResponse is the unified shape the task spec calls
// out: every documented field exists on the row regardless of
// whether the caller scoped by userId or by boardId.
type permissionResponse struct {
	ID                string  `json:"id"`
	UserID            string  `json:"userId"`
	Username          string  `json:"username"`
	Nickname          string  `json:"nickname"`
	UserType          string  `json:"userType"`
	UserRole          string  `json:"userRole"`
	BoardID           string  `json:"boardId"`
	BoardName         string  `json:"boardName"`
	Access            string  `json:"access"`
	OwnerAgentID      *string `json:"ownerAgentId"`
	GrantedByUserID   *string `json:"grantedByUserId"`
	GrantedByUsername *string `json:"grantedByUsername"`
	GrantedByNickname *string `json:"grantedByNickname"`
	GrantedAt         *string `json:"grantedAt"`
	ExpiresAt         *string `json:"expiresAt"`
	RevokedAt         *string `json:"revokedAt"`
}

type permissionsEnvelope struct {
	Permissions []permissionResponse `json:"permissions"`
}

func decodePermissions(t *testing.T, body []byte) []permissionResponse {
	t.Helper()
	var env permissionsEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode permissions: %v", err)
	}
	return env.Permissions
}

// expectedPermissionRowKeys is the canonical field set the s-1041
// task spec promises both ?userId= and ?boardId= responses must
// satisfy. The test compares the JSON-decoded keys against this
// set to catch both missing fields AND accidental drift.
//
// s-1047 extends the set with grantedByUsername / grantedByNickname
// so the BoardPermissionsModal can render "授权人 username" without
// having to round-trip through a separate /users endpoint for every
// row. The two new keys are non-null whenever grantedByUserId is
// non-null — a granted_by_user_id pointing at a deleted user would
// surface as a null username (matching the LEFT JOIN semantics).
var expectedPermissionRowKeys = map[string]bool{
	"id":                true,
	"userId":            true,
	"username":          true,
	"nickname":          true,
	"userType":          true,
	"userRole":          true,
	"boardId":           true,
	"boardName":         true,
	"access":            true,
	"ownerAgentId":      true,
	"grantedByUserId":   true,
	"grantedByUsername": true,
	"grantedByNickname": true,
	"grantedAt":         true,
	"expiresAt":         true,
	"revokedAt":         true,
}

// assertPermissionShape checks that every row carries exactly the
// documented field set and that no extra / missing keys have
// slipped in. It does NOT assert any specific values — that's the
// job of the field-specific assertions in each test.
func assertPermissionShape(t *testing.T, rows []map[string]interface{}) {
	t.Helper()
	if len(rows) == 0 {
		t.Fatal("expected at least one permission row to assert shape against")
	}
	row := rows[0]
	for key := range expectedPermissionRowKeys {
		if _, ok := row[key]; !ok {
			t.Errorf("expected key %q in row, got keys %v", key, mapKeys(row))
		}
	}
	for key := range row {
		if !expectedPermissionRowKeys[key] {
			t.Errorf("unexpected key %q in row, got keys %v", key, mapKeys(row))
		}
	}
}

// TestGetPermissions_UnifiedResponseShape is the central promise
// of s-1041: the ?userId= and ?boardId= variants of
// GET /api/v1/auth/permissions return the same PermissionRow
// shape. Field drift between the two branches is exactly what the
// task spec is fixing — without this test, a future PR could
// quietly re-introduce the divergence.
func TestGetPermissions_UnifiedResponseShape(t *testing.T) {
	db := setupUnifiedPermissionsDB(t)
	defer db.Close()

	t.Run("boardId variant carries the full unified shape", func(t *testing.T) {
		w := callGetPermissions(t, db, "admin-token", "boardId=board1")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		// Decode into a generic map so the assertion catches any
		// drift in field names — a typed decode would silently
		// accept missing fields.
		var raw struct {
			Permissions []map[string]interface{} `json:"permissions"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(raw.Permissions) == 0 {
			t.Fatalf("expected non-empty permissions list, got 0")
		}
		assertPermissionShape(t, raw.Permissions)
	})

	t.Run("userId variant carries the full unified shape", func(t *testing.T) {
		// admin1 sees their own permissions without needing
		// any special role since requestedUserID == user.ID.
		w := callGetPermissions(t, db, "admin-token", "")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var raw struct {
			Permissions []map[string]interface{} `json:"permissions"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(raw.Permissions) == 0 {
			t.Fatalf("expected admin1 to have at least one permission row, got 0")
		}
		assertPermissionShape(t, raw.Permissions)
	})

	t.Run("admin querying another user's grants still carries the unified shape", func(t *testing.T) {
		w := callGetPermissions(t, db, "admin-token", "userId=member1")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var raw struct {
			Permissions []map[string]interface{} `json:"permissions"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(raw.Permissions) == 0 {
			t.Fatalf("expected member1 to have a permission row, got 0")
		}
		assertPermissionShape(t, raw.Permissions)
	})

	t.Run("field set is byte-identical between boardId and userId variants", func(t *testing.T) {
		wBoard := callGetPermissions(t, db, "admin-token", "boardId=board1")
		if wBoard.Code != http.StatusOK {
			t.Fatalf("expected 200 for boardId, got %d: %s", wBoard.Code, wBoard.Body.String())
		}

		// member1 has exactly one row on board1, so the userId
		// variant returns the same singleton row. We pick
		// member1's row out of the boardId response and compare
		// its keys against the userId response's only row.
		wUser := callGetPermissions(t, db, "admin-token", "userId=member1")
		if wUser.Code != http.StatusOK {
			t.Fatalf("expected 200 for userId, got %d: %s", wUser.Code, wUser.Body.String())
		}

		var boardRaw, userRaw struct {
			Permissions []map[string]interface{} `json:"permissions"`
		}
		if err := json.Unmarshal(wBoard.Body.Bytes(), &boardRaw); err != nil {
			t.Fatalf("decode board response: %v", err)
		}
		if err := json.Unmarshal(wUser.Body.Bytes(), &userRaw); err != nil {
			t.Fatalf("decode user response: %v", err)
		}

		if len(boardRaw.Permissions) < 1 {
			t.Fatalf("expected at least 1 row for boardId, got %d", len(boardRaw.Permissions))
		}
		if len(userRaw.Permissions) != 1 {
			t.Fatalf("expected 1 row for member1, got %d", len(userRaw.Permissions))
		}

		// Pick the member1 row out of the boardId response so the
		// key-set comparison is "same user, two different query
		// modes" rather than "two different users".
		var member1FromBoard map[string]interface{}
		for _, r := range boardRaw.Permissions {
			if r["userId"] == "member1" {
				member1FromBoard = r
				break
			}
		}
		if member1FromBoard == nil {
			t.Fatalf("member1 row not found in boardId response, got users=%v", usersOf(boardRaw.Permissions))
		}

		bKeys := mapKeys(member1FromBoard)
		uKeys := mapKeys(userRaw.Permissions[0])
		if len(bKeys) != len(uKeys) {
			t.Errorf("key count drift: boardId/member1=%d (%v) vs userId/member1=%d (%v)", len(bKeys), bKeys, len(uKeys), uKeys)
		}
		keySet := make(map[string]bool, len(bKeys))
		for _, k := range bKeys {
			keySet[k] = true
		}
		for _, k := range uKeys {
			if !keySet[k] {
				t.Errorf("userId variant has key %q that boardId variant lacks", k)
			}
		}
	})
}

// usersOf returns the userId values across a list of raw
// permission rows, used in error messages to identify which
// users the response actually carried.
func usersOf(rows []map[string]interface{}) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if u, ok := r["userId"].(string); ok {
			out = append(out, u)
		}
	}
	return out
}

// mapKeys returns the keys of a map[string]interface{} for
// diagnostic output in error messages. A typed equivalent
// (`keysOf[V]`) is used below for map[string]permissionResponse.
func mapKeys(m map[string]interface{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestGetPermissions_UnifiedResponseValues verifies the unified
// row projects the correct VALUES, not just the correct field set.
// The audit fields (grantedByUserId, expiresAt) are the most likely
// to drift because the original handler omitted them entirely on
// the ?userId= branch.
func TestGetPermissions_UnifiedResponseValues(t *testing.T) {
	db := setupUnifiedPermissionsDB(t)
	defer db.Close()

	t.Run("boardId variant projects user / board / grantedBy / expiresAt correctly", func(t *testing.T) {
		w := callGetPermissions(t, db, "admin-token", "boardId=board1")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		rows := decodePermissions(t, w.Body.Bytes())
		byUser := make(map[string]permissionResponse, len(rows))
		for _, r := range rows {
			byUser[r.UserID] = r
		}

		// admin1: owns board1, granted by admin1 (self-grant on
		// create), expiresAt=null.
		admin, ok := byUser["admin1"]
		if !ok {
			t.Fatalf("expected admin1 row, got users=%v", keysOf(byUser))
		}
		if admin.UserType != "HUMAN" || admin.UserRole != "ADMIN" {
			t.Errorf("admin1 userType/userRole: got %q/%q, want HUMAN/ADMIN", admin.UserType, admin.UserRole)
		}
		if admin.Username != "admin1" || admin.Nickname != "Admin One" {
			t.Errorf("admin1 username/nickname: got %q/%q", admin.Username, admin.Nickname)
		}
		if admin.Access != "ADMIN" || admin.BoardID != "board1" || admin.BoardName != "Board One" {
			t.Errorf("admin1 access/board: got %q/%q/%q", admin.Access, admin.BoardID, admin.BoardName)
		}
		if admin.OwnerAgentID == nil || *admin.OwnerAgentID != "admin1" {
			t.Errorf("admin1 ownerAgentId: got %v, want admin1", admin.OwnerAgentID)
		}
		if admin.GrantedByUserID == nil || *admin.GrantedByUserID != "admin1" {
			t.Errorf("admin1 grantedByUserId: got %v, want admin1", admin.GrantedByUserID)
		}
		// s-1047: grantedByUsername / grantedByNickname must be
		// projected from the LEFT JOIN on users so the frontend
		// BoardPermissionsModal can render "授权人 username"
		// without a follow-up /users round trip. Both should
		// reflect admin1's seed data.
		if admin.GrantedByUsername == nil || *admin.GrantedByUsername != "admin1" {
			t.Errorf("admin1 grantedByUsername: got %v, want admin1", admin.GrantedByUsername)
		}
		if admin.GrantedByNickname == nil || *admin.GrantedByNickname != "Admin One" {
			t.Errorf("admin1 grantedByNickname: got %v, want Admin One", admin.GrantedByNickname)
		}
		if admin.ExpiresAt != nil {
			t.Errorf("admin1 expiresAt: got %v, want null", *admin.ExpiresAt)
		}
		if admin.RevokedAt != nil {
			t.Errorf("admin1 revokedAt: got %v, want null", *admin.RevokedAt)
		}

		// member1: granted by admin1, expiresAt=null.
		m1, ok := byUser["member1"]
		if !ok {
			t.Fatalf("expected member1 row, got users=%v", keysOf(byUser))
		}
		if m1.Access != "WRITE" {
			t.Errorf("member1 access: got %q, want WRITE", m1.Access)
		}
		if m1.Nickname != "Member One" || m1.UserRole != "MEMBER" {
			t.Errorf("member1 nickname/role: got %q/%q", m1.Nickname, m1.UserRole)
		}
		if m1.OwnerAgentID != nil {
			t.Errorf("member1 ownerAgentId: got %v, want null", m1.OwnerAgentID)
		}
		if m1.GrantedByUserID == nil || *m1.GrantedByUserID != "admin1" {
			t.Errorf("member1 grantedByUserId: got %v, want admin1", m1.GrantedByUserID)
		}
		if m1.ExpiresAt != nil {
			t.Errorf("member1 expiresAt: got %v, want null", *m1.ExpiresAt)
		}

		// expired1: expiresAt populated with a non-empty RFC3339
		// string. We only assert non-nil + non-empty because the
		// exact value depends on test-DB clock semantics and
		// shouldn't be coupled to wall-clock time.
		exp, ok := byUser["expired1"]
		if !ok {
			t.Fatalf("expected expired1 row, got users=%v", keysOf(byUser))
		}
		if exp.ExpiresAt == nil || *exp.ExpiresAt == "" {
			t.Errorf("expired1 expiresAt: got %v, want non-empty", exp.ExpiresAt)
		}
	})

	t.Run("userId variant projects the same fields with the same values", func(t *testing.T) {
		// member1 has exactly one row on board1; the userId
		// variant must project every audit field the boardId
		// variant does.
		w := callGetPermissions(t, db, "admin-token", "userId=member1")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		rows := decodePermissions(t, w.Body.Bytes())
		if len(rows) != 1 {
			t.Fatalf("expected 1 row for member1, got %d", len(rows))
		}
		row := rows[0]

		if row.UserID != "member1" || row.Username != "member1" || row.Nickname != "Member One" {
			t.Errorf("member1 user fields: got userId=%q username=%q nickname=%q", row.UserID, row.Username, row.Nickname)
		}
		if row.UserType != "HUMAN" || row.UserRole != "MEMBER" {
			t.Errorf("member1 userType/userRole: got %q/%q", row.UserType, row.UserRole)
		}
		if row.BoardID != "board1" || row.BoardName != "Board One" || row.Access != "WRITE" {
			t.Errorf("member1 board/access: got boardId=%q boardName=%q access=%q", row.BoardID, row.BoardName, row.Access)
		}
		// This is the regression assertion the task spec calls
		// out: prior to s-1041 the userId variant did NOT
		// project grantedByUserId / expiresAt / revokedAt /
		// username / nickname / userType / userRole. They must
		// now all be present.
		if row.GrantedByUserID == nil || *row.GrantedByUserID != "admin1" {
			t.Errorf("member1 grantedByUserId: got %v, want admin1", row.GrantedByUserID)
		}
		if row.ExpiresAt != nil {
			t.Errorf("member1 expiresAt: got %v, want null", *row.ExpiresAt)
		}
		if row.RevokedAt != nil {
			t.Errorf("member1 revokedAt: got %v, want null", *row.RevokedAt)
		}
		if row.OwnerAgentID != nil {
			t.Errorf("member1 ownerAgentId: got %v, want null", row.OwnerAgentID)
		}
	})
}

// TestGetPermissions_EmptyArrayOnNoGrants guards the "always
// return []" promise from the API style guide, applied to the
// unified shape: an empty permissions array must still be [] in
// the JSON body (not null) regardless of which branch was hit.
// board2 is seeded with no permission rows, which gives us a clean
// empty path for both branches.
func TestGetPermissions_EmptyArrayOnNoGrants(t *testing.T) {
	db := setupUnifiedPermissionsDB(t)
	defer db.Close()

	t.Run("boardId variant with zero rows returns permissions:[]", func(t *testing.T) {
		w := callGetPermissions(t, db, "admin-token", "boardId=board2")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		if !bodyContains(w.Body.String(), `"permissions":[]`) {
			t.Errorf("expected permissions:[] in body, got %s", w.Body.String())
		}
	})
}

// TestGetPermissions_NoUserNicknameKeyAlias is the explicit
// anti-regression guard for the field-name change. Prior to
// s-1041, the boardId variant used `userNickname` while the userId
// variant used nothing at all. Both must now use `nickname` (per
// the task spec) and the legacy `userNickname` key must NOT
// appear.
func TestGetPermissions_NoUserNicknameKeyAlias(t *testing.T) {
	db := setupUnifiedPermissionsDB(t)
	defer db.Close()

	w := callGetPermissions(t, db, "admin-token", "boardId=board1")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var raw struct {
		Permissions []map[string]interface{} `json:"permissions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, row := range raw.Permissions {
		if _, ok := row["userNickname"]; ok {
			t.Errorf("legacy userNickname key leaked into response row, keys=%v", mapKeys(row))
		}
		if _, ok := row["nickname"]; !ok {
			t.Errorf("expected nickname key in response row, keys=%v", mapKeys(row))
		}
	}
}

// keysOf returns the keys of a map[string]V for diagnostic output
// in error messages — keeps failure logs readable when the test
// is comparing per-user projections.
func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestGetPermissions_GrantedByUsernameNullable verifies the LEFT
// JOIN introduced for s-1047 degrades gracefully: a board_permission
// row whose granted_by_user_id is NULL (e.g. legacy rows created
// before the audit columns existed, or hand-inserted rows from
// board creation) must surface as null grantedByUsername /
// grantedByNickname instead of crashing the scan or returning
// empty strings. An empty string in either field would confuse the
// frontend modal into rendering "授权人: " with no value; a null
// is what the JS side types the optional field as, so the modal
// simply omits the line.
func TestGetPermissions_GrantedByUsernameNullable(t *testing.T) {
	db := setupUnifiedPermissionsDB(t)
	defer db.Close()

	// Seed a board + permission row with no granted_by stamp. We
	// reuse board2 (no permission rows seeded by the fixture) and
	// grant anonymous access so the LEFT JOIN matches the "no
	// users row" path the modal would also see in production.
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('anon1', 'anon1', 'Anon One', 'pass', 'MEMBER', 1, '', 'HUMAN')`,
	); err != nil {
		t.Fatalf("seed anon user: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, granted_by_user_id, expires_at, revoked_at) VALUES ('bp-anon', 'anon1', 'board2', NULL, 'READ', NULL, NULL, NULL)`,
	); err != nil {
		t.Fatalf("seed anonymous perm: %v", err)
	}

	w := callGetPermissions(t, db, "admin-token", "boardId=board2")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	rows := decodePermissions(t, w.Body.Bytes())
	if len(rows) != 1 {
		t.Fatalf("expected 1 row for board2, got %d", len(rows))
	}
	row := rows[0]
	if row.UserID != "anon1" {
		t.Fatalf("expected userId=anon1, got %q", row.UserID)
	}
	// The whole point of this test: the three audit-keyed fields
	// about the granting actor all come back as JSON null (not
	// empty string, not the wrong user). The frontend's optional
	// chained reads (`perm.grantedByUsername ?? perm.grantedByNickname`)
	// short-circuit to "—" / no-label when the keys are null.
	if row.GrantedByUserID != nil {
		t.Errorf("anon1 grantedByUserId: got %v, want null", *row.GrantedByUserID)
	}
	if row.GrantedByUsername != nil {
		t.Errorf("anon1 grantedByUsername: got %q, want null", *row.GrantedByUsername)
	}
	if row.GrantedByNickname != nil {
		t.Errorf("anon1 grantedByNickname: got %q, want null", *row.GrantedByNickname)
	}
}