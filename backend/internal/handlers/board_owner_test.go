package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// setupBoardOwnerDB returns a freshly seeded SQLite with the
// minimum schema for board-owner tests. Seeds:
//
//   - admin1 (ADMIN), member1 (MEMBER), member2 (MEMBER), viewer1 (VIEWER)
//   - board1 with admin1 as the owner (via owner_agent_id on admin1's row)
//   - board2 with NO permission rows
//
// member1 and member2 each have a permission row on board1 with
// no owner stamp, so the non-owner-non-admin denial path is
// exercised naturally.
func setupBoardOwnerDB(t *testing.T) *sql.DB {
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
		action TEXT NOT NULL CHECK(action IN ('CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'ADD_COMMENT', 'LOGIN', 'LOGOUT', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'COLUMN_CREATE', 'COLUMN_UPDATE', 'COLUMN_DELETE', 'USER_CREATE', 'USER_UPDATE', 'BOARD_COPY', 'TEMPLATE_CREATE', 'TEMPLATE_DELETE', 'BOARD_IMPORT', 'APP_CONFIG_UPDATE', 'PERMISSION_GRANT', 'PERMISSION_REVOKE')),
		target_type TEXT NOT NULL CHECK(target_type IN ('TASK', 'COMMENT', 'BOARD', 'COLUMN', 'USER', 'SYSTEM', 'TEMPLATE')),
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	for _, u := range []struct{ id, nick, role string }{
		{"admin1", "admin", "ADMIN"},
		{"member1", "member", "MEMBER"},
		{"member2", "member-two", "MEMBER"},
		{"viewer1", "viewer", "VIEWER"},
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
	} {
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			tok.id, tok.key, tok.user,
		); err != nil {
			t.Fatalf("failed to seed token %s: %v", tok.id, err)
		}
	}

	for _, b := range []struct{ id, name string }{
		{"board1", "Board One"},
		{"board2", "Board Two"},
	} {
		if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES (?, ?)`, b.id, b.name); err != nil {
			t.Fatalf("failed to seed board %s: %v", b.id, err)
		}
	}

	rows := []struct {
		id, user, board, owner, access string
	}{
		{"bp-admin-board1", "admin1", "board1", "admin1", "ADMIN"},
		{"bp-member1-board1", "member1", "board1", "", "READ"},
		{"bp-member2-board1", "member2", "board1", "", "READ"},
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
			t.Fatalf("failed to seed permission %s: %v", r.id, err)
		}
	}

	return db
}

func TestIsBoardOwner(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	t.Run("owner flagged via owner_agent_id returns true", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		owner, err := IsBoardOwner(db, "admin1", "board1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !owner {
			t.Error("expected admin1 to be reported as board1 owner")
		}
	})

	t.Run("member with row but no owner_agent_id returns false", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		owner, err := IsBoardOwner(db, "member1", "board1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if owner {
			t.Error("expected member1 NOT to be reported as owner (no owner_agent_id)")
		}
	})

	t.Run("non-existent permission row returns false without error", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		owner, err := IsBoardOwner(db, "admin1", "board2")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if owner {
			t.Error("expected admin1 NOT to be reported as owner of board2 (no permission row)")
		}
	})

	t.Run("empty user id short-circuits to false", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		owner, err := IsBoardOwner(db, "", "board1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if owner {
			t.Error("expected empty user id to short-circuit to false")
		}
	})

	t.Run("empty board id short-circuits to false", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		owner, err := IsBoardOwner(db, "admin1", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if owner {
			t.Error("expected empty board id to short-circuit to false")
		}
	})
}

func TestCheckBoardAccess_OwnerHasAdminAccess(t *testing.T) {
	ResetPermissionCacheForTest()

	t.Run("owner without admin role still has ADMIN access", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		if _, err := db.Exec(
			`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
		); err != nil {
			t.Fatalf("failed to promote member1 to owner: %v", err)
		}
		ResetPermissionCacheForTest()

		if !checkBoardAccess(db, "member1", "board1", "ADMIN", "MEMBER") {
			t.Error("expected board owner member1 to have ADMIN access on board1")
		}
		if !checkBoardAccess(db, "member1", "board1", "WRITE", "MEMBER") {
			t.Error("expected board owner member1 to have WRITE access on board1")
		}
		if !checkBoardAccess(db, "member1", "board1", "READ", "MEMBER") {
			t.Error("expected board owner member1 to have READ access on board1")
		}
	})

	t.Run("owner_agent_id only short-circuits when it matches user_id", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		ResetPermissionCacheForTest()

		// member1's row has owner_agent_id = admin1, so the owner
		// short-circuit must NOT fire for member1.
		if checkBoardAccess(db, "member1", "board1", "ADMIN", "MEMBER") {
			t.Error("expected member1 to NOT have ADMIN access (owner_agent_id is admin1)")
		}
		if !checkBoardAccess(db, "admin1", "board1", "ADMIN", "ADMIN") {
			t.Error("expected admin1 to still have ADMIN access (owns board1)")
		}
	})

	t.Run("VIEWER owner still gets ADMIN access", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer db.Close()

		if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES ('bp-viewer', 'viewer1', 'board1', 'viewer1', 'READ')`); err != nil {
			t.Fatalf("failed to seed viewer owner: %v", err)
		}
		ResetPermissionCacheForTest()

		if !checkBoardAccess(db, "viewer1", "board1", "ADMIN", "VIEWER") {
			t.Error("expected VIEWER-as-owner to have ADMIN access via owner short-circuit")
		}
	})
}

func TestSetPermission_BoardOwnerCanGrant(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to owner: %v", err)
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/permissions", SetPermission(db))

	body := map[string]interface{}{"userId": "member2", "boardId": "board1", "access": "WRITE"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to grant permission (200), got %d: %s", w.Code, w.Body.String())
	}

	var access string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'member2' AND board_id = 'board1'`,
	).Scan(&access); err != nil {
		t.Fatalf("failed to read back permission: %v", err)
	}
	if access != "WRITE" {
		t.Errorf("expected member2 access to be WRITE, got %q", access)
	}
}

func TestSetPermission_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/permissions", SetPermission(db))

	body := map[string]interface{}{"userId": "member2", "boardId": "board1", "access": "WRITE"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSetPermission_AdminCanStillGrant(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/permissions", SetPermission(db))

	body := map[string]interface{}{"userId": "member2", "boardId": "board1", "access": "WRITE"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected admin to grant permission (200), got %d: %s", w.Code, w.Body.String())
	}
}

func TestSetPermission_OwnerCanDemoteSelf(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/permissions", SetPermission(db))

	// Demote admin1's access on their own owned row from ADMIN to READ.
	body := map[string]interface{}{"userId": "admin1", "boardId": "board1", "access": "READ"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/permissions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected admin demotion to succeed (200), got %d: %s", w.Code, w.Body.String())
	}

	var access string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'admin1' AND board_id = 'board1'`,
	).Scan(&access); err != nil {
		t.Fatalf("failed to read back: %v", err)
	}
	if access != "READ" {
		t.Errorf("expected admin1 access to be demoted to READ, got %q", access)
	}

	// Owner short-circuit should still grant ADMIN because the
	// owner_agent_id is intact.
	ResetPermissionCacheForTest()
	if !checkBoardAccess(db, "admin1", "board1", "ADMIN", "ADMIN") {
		t.Error("expected owner short-circuit to still grant ADMIN after access demotion")
	}
}

func TestDeletePermission_BoardOwnerCanRevoke(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to owner: %v", err)
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.DELETE("/api/permissions", DeletePermission(db))

	req, _ := http.NewRequest("DELETE", "/api/permissions?id=bp-member2-board1", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to revoke permission (200), got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE id = 'bp-member2-board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("failed to count rows: %v", err)
	}
	if count != 0 {
		t.Errorf("expected bp-member2-board1 to be deleted, found %d rows", count)
	}
}

func TestDeletePermission_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.DELETE("/api/permissions", DeletePermission(db))

	req, _ := http.NewRequest("DELETE", "/api/permissions?id=bp-member2-board1", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin revoke, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeletePermission_CannotRevokeOwner(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.DELETE("/api/permissions", DeletePermission(db))

	// admin1 is the owner of board1; another admin attempts to
	// revoke admin1's permission row. The handler must refuse.
	req, _ := http.NewRequest("DELETE", "/api/permissions?id=bp-admin-board1", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 when deleting owner permission, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE id = 'bp-admin-board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("failed to count rows: %v", err)
	}
	if count != 1 {
		t.Errorf("expected bp-admin-board1 to still exist, found %d rows", count)
	}
}

func TestDeletePermission_OwnerCannotRevokeSelf(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.DELETE("/api/permissions", DeletePermission(db))

	// admin1 owns board1; trying to self-revoke their permission
	// row must be denied.
	req, _ := http.NewRequest("DELETE", "/api/permissions?id=bp-admin-board1", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 when owner self-revokes, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateBoard_AssignsOwner(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/boards", CreateBoard(db))

	body := map[string]interface{}{"name": "Fresh Board"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.ID == "" {
		t.Fatal("expected non-empty board id in response")
	}

	var ownerID sql.NullString
	var access string
	if err := db.QueryRow(
		`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = 'admin1' AND board_id = ?`,
		resp.ID,
	).Scan(&ownerID, &access); err != nil {
		t.Fatalf("expected creator permission row, got error: %v", err)
	}
	if !ownerID.Valid || ownerID.String != "admin1" {
		t.Errorf("expected owner_agent_id=admin1, got %v", ownerID)
	}
	if access != "ADMIN" {
		t.Errorf("expected access=ADMIN, got %q", access)
	}

	if _, err := db.Exec(`DELETE FROM boards WHERE id = ?`, resp.ID); err != nil {
		t.Fatalf("cleanup: failed to delete test board: %v", err)
	}
}

func TestCreateBoard_AssignsOwnerForNonAdminCreator(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/boards", CreateBoard(db))

	body := map[string]interface{}{"name": "Member Board"}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	var ownerID sql.NullString
	if err := db.QueryRow(
		`SELECT owner_agent_id FROM board_permissions WHERE user_id = 'member1' AND board_id = ?`,
		resp.ID,
	).Scan(&ownerID); err != nil {
		t.Fatalf("expected creator permission row: %v", err)
	}
	if !ownerID.Valid || ownerID.String != "member1" {
		t.Errorf("expected owner_agent_id=member1, got %v", ownerID)
	}

	ResetPermissionCacheForTest()
	if !checkBoardAccess(db, "member1", resp.ID, "ADMIN", "MEMBER") {
		t.Error("expected MEMBER-as-owner to have ADMIN access on freshly created board")
	}

	if _, err := db.Exec(`DELETE FROM boards WHERE id = ?`, resp.ID); err != nil {
		t.Fatalf("cleanup: failed to delete test board: %v", err)
	}
}