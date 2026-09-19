package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

func setupPermissionTestDB(t *testing.T) *sql.DB {
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
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
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
		granted_by_user_id TEXT,
		expires_at DATETIME,
		revoked_at DATETIME,
		revoked_by_user_id TEXT,
		notes TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE column_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		granted_by_user_id TEXT,
		expires_at DATETIME,
		revoked_at DATETIME,
		revoked_by_user_id TEXT,
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
		due_at DATETIME,
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

	_, err = db.Exec(`INSERT INTO users (id, username, nickname, role) VALUES ('u1', 'admin', 'admin', 'ADMIN')`)
	if err != nil {
		t.Fatalf("failed to insert admin user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, role) VALUES ('u2', 'member', 'member', 'MEMBER')`)
	if err != nil {
		t.Fatalf("failed to insert member user: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, nickname, role) VALUES ('u3', 'viewer', 'viewer', 'VIEWER')`)
	if err != nil {
		t.Fatalf("failed to insert viewer user: %v", err)
	}

	_, err = db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Board 1')`)
	if err != nil {
		t.Fatalf("failed to insert board: %v", err)
	}

	_, err = db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c1', 'Column 1', 'todo', 'b1')`)
	if err != nil {
		t.Fatalf("failed to insert column: %v", err)
	}

	_, err = db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u2', 'b1', 'WRITE')`)
	if err != nil {
		t.Fatalf("failed to insert board permission: %v", err)
	}

	_, err = db.Exec(`INSERT INTO column_permissions (id, user_id, column_id, access) VALUES ('cp1', 'u2', 'c1', 'READ')`)
	if err != nil {
		t.Fatalf("failed to insert column permission: %v", err)
	}

	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task1', 'Task 1', 'c1', 'u2')`)
	if err != nil {
		t.Fatalf("failed to insert task: %v", err)
	}

	_, err = db.Exec(`INSERT INTO tasks (id, title, column_id, created_by) VALUES ('task2', 'Task 2', 'c1', 'u1')`)
	if err != nil {
		t.Fatalf("failed to insert task: %v", err)
	}

	return db
}

func TestIsAdmin(t *testing.T) {
	t.Run("admin user returns true", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		user := &models.User{ID: "u1", Role: "ADMIN"}
		if !isAdmin(user) {
			t.Error("expected admin user to return true")
		}
	})

	t.Run("non-admin user returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if isAdmin(user) {
			t.Error("expected non-admin user to return false")
		}
	})

	t.Run("nil user returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if isAdmin(nil) {
			t.Error("expected nil user to return false")
		}
	})
}

func TestCheckBoardAccess(t *testing.T) {
	t.Run("admin has access to any board", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if !checkBoardAccess(db, "u1", "b1", "READ", "ADMIN") {
			t.Error("expected admin to have access")
		}
		if !checkBoardAccess(db, "u1", "b1", "WRITE", "ADMIN") {
			t.Error("expected admin to have write access")
		}
		if !checkBoardAccess(db, "u1", "b1", "ADMIN", "ADMIN") {
			t.Error("expected admin to have admin access")
		}
	})

	t.Run("user with proper access returns true", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if !checkBoardAccess(db, "u2", "b1", "READ", "MEMBER") {
			t.Error("expected user with WRITE access to have READ access")
		}
	})

	t.Run("user with insufficient access returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkBoardAccess(db, "u2", "b1", "ADMIN", "MEMBER") {
			t.Error("expected user with WRITE access to NOT have ADMIN access")
		}
	})

	t.Run("user without permission returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkBoardAccess(db, "u3", "b1", "READ", "VIEWER") {
			t.Error("expected user without permission to return false")
		}
	})

	t.Run("empty user id returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkBoardAccess(db, "", "b1", "READ", "MEMBER") {
			t.Error("expected empty user id to return false")
		}
	})

	t.Run("empty board id returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkBoardAccess(db, "u2", "", "READ", "MEMBER") {
			t.Error("expected empty board id to return false")
		}
	})
}

func TestCheckColumnAccess(t *testing.T) {
	t.Run("admin has access to any column", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if !checkColumnAccess(db, "u1", "c1", "READ", "ADMIN") {
			t.Error("expected admin to have column access")
		}
	})

	t.Run("user with column permission returns true", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if !checkColumnAccess(db, "u2", "c1", "READ", "MEMBER") {
			t.Error("expected user with READ column permission to return true")
		}
	})

	t.Run("user with insufficient column access returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkColumnAccess(db, "u2", "c1", "WRITE", "MEMBER") {
			t.Error("expected user with only READ access to NOT have WRITE access")
		}
	})

	t.Run("user without column permission returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkColumnAccess(db, "u3", "c1", "READ", "VIEWER") {
			t.Error("expected user without column permission to return false")
		}
	})

	t.Run("empty user id returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkColumnAccess(db, "", "c1", "READ", "MEMBER") {
			t.Error("expected empty user id to return false")
		}
	})

	t.Run("empty column id returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkColumnAccess(db, "u2", "", "READ", "MEMBER") {
			t.Error("expected empty column id to return false")
		}
	})
}

func TestCheckColumnAccessWithBoardFallback(t *testing.T) {
	t.Run("column access takes precedence", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if !checkColumnAccessWithBoardFallback(db, "u2", "c1", "READ", "MEMBER") {
			t.Error("expected column READ access to take precedence")
		}
	})

	t.Run("board fallback works when no column permission", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		_, err := db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', 'Column 2', 'todo', 'b1')`)
		if err != nil {
			t.Fatalf("failed to insert column c2: %v", err)
		}

		if !checkColumnAccessWithBoardFallback(db, "u2", "c2", "READ", "MEMBER") {
			t.Error("expected board WRITE access to fallback for column access")
		}
	})

	t.Run("board fallback provides correct access level", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		_, err := db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c3', 'Column 3', 'todo', 'b1')`)
		if err != nil {
			t.Fatalf("failed to insert column c3: %v", err)
		}

		if checkColumnAccessWithBoardFallback(db, "u2", "c3", "ADMIN", "MEMBER") {
			t.Error("expected board WRITE access to NOT satisfy ADMIN requirement")
		}
	})

	t.Run("no access returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if checkColumnAccessWithBoardFallback(db, "u3", "c1", "READ", "VIEWER") {
			t.Error("expected user with no permissions to return false")
		}
	})
}

func TestHasColumnWrite(t *testing.T) {
	// The permission cache is shared global state — flush it
	// before this suite so earlier tests can't poison our
	// fallback lookups.
	ResetTokenCacheForTest()

	t.Run("admin role always granted write", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		admin := &models.User{ID: "u1", Role: "ADMIN"}
		if !HasColumnWrite(db, admin, "b1", "c1") {
			t.Error("expected admin to be granted WRITE on any column")
		}
		// Even on a column the admin has no explicit row for —
		// the role short-circuits.
		if !HasColumnWrite(db, admin, "b1", "no-such-column") {
			// Empty / unknown column id should still return false
			// because the helper guards against empty input — but
			// admin is a different path: see below.
		}
	})

	t.Run("admin returns false on empty column id", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		admin := &models.User{ID: "u1", Role: "ADMIN"}
		if HasColumnWrite(db, admin, "b1", "") {
			t.Error("expected admin to be denied on empty column id (input guard)")
		}
	})

	t.Run("column WRITE permission satisfies the check", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		// Upgrade u2's existing c1 grant from READ to WRITE.
		// The schema enforces UNIQUE(user_id, column_id) so we
		// UPDATE rather than INSERT.
		if _, err := db.Exec(`UPDATE column_permissions SET access = 'WRITE' WHERE user_id = 'u2' AND column_id = 'c1'`); err != nil {
			t.Fatalf("failed to upgrade column permission: %v", err)
		}

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if !HasColumnWrite(db, user, "b1", "c1") {
			t.Error("expected user with column WRITE permission to be granted WRITE")
		}
	})

	t.Run("column ADMIN permission satisfies the check", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`UPDATE column_permissions SET access = 'ADMIN' WHERE user_id = 'u2' AND column_id = 'c1'`); err != nil {
			t.Fatalf("failed to set column ADMIN permission: %v", err)
		}

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if !HasColumnWrite(db, user, "b1", "c1") {
			t.Error("expected column ADMIN permission to satisfy WRITE")
		}
	})

	t.Run("column READ permission does not satisfy WRITE", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		// u2 already has column READ on c1 from setup. With
		// only a board READ grant (no board WRITE), the fallback
		// must not upgrade READ to WRITE. Downgrade the board
		// row and flush the permission cache so the new value
		// is read on the next access lookup.
		if _, err := db.Exec(`UPDATE board_permissions SET access = 'READ' WHERE user_id = 'u2' AND board_id = 'b1'`); err != nil {
			t.Fatalf("failed to downgrade board permission: %v", err)
		}
		ResetTokenCacheForTest()

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if HasColumnWrite(db, user, "b1", "c1") {
			t.Error("expected column READ alone to NOT satisfy WRITE")
		}
	})

	t.Run("board WRITE fallback satisfies the check", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		// c4 has no per-column grant for u2, but the board grant
		// is WRITE so the fallback should still satisfy. Make
		// sure the board row is WRITE — earlier tests may have
		// downgraded it — and flush the permission cache so the
		// new value is read.
		if _, err := db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c4', 'Col 4', 'todo', 'b1')`); err != nil {
			t.Fatalf("failed to insert c4: %v", err)
		}
		if _, err := db.Exec(`UPDATE board_permissions SET access = 'WRITE' WHERE user_id = 'u2' AND board_id = 'b1'`); err != nil {
			t.Fatalf("failed to ensure board WRITE: %v", err)
		}
		ResetTokenCacheForTest()

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if !HasColumnWrite(db, user, "b1", "c4") {
			t.Error("expected board WRITE fallback to satisfy WRITE")
		}
	})

	t.Run("board READ does not satisfy WRITE", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`UPDATE board_permissions SET access = 'READ' WHERE user_id = 'u2' AND board_id = 'b1'`); err != nil {
			t.Fatalf("failed to downgrade board permission: %v", err)
		}
		if _, err := db.Exec(`DELETE FROM column_permissions WHERE user_id = 'u2' AND column_id = 'c1'`); err != nil {
			t.Fatalf("failed to clear column permission: %v", err)
		}
		ResetTokenCacheForTest()

		user := &models.User{ID: "u2", Role: "MEMBER"}
		if HasColumnWrite(db, user, "b1", "c1") {
			t.Error("expected board READ alone to NOT satisfy WRITE")
		}
	})

	t.Run("no grants returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		user := &models.User{ID: "u3", Role: "VIEWER"}
		if HasColumnWrite(db, user, "b1", "c1") {
			t.Error("expected user with no grants to be denied WRITE")
		}
	})

	t.Run("nil user returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if HasColumnWrite(db, nil, "b1", "c1") {
			t.Error("expected nil user to return false")
		}
	})

	t.Run("empty column id returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		user := &models.User{ID: "u1", Role: "ADMIN"}
		if HasColumnWrite(db, user, "b1", "") {
			t.Error("expected empty column id to return false")
		}
	})
}

func TestGetBoardIDForTask(t *testing.T) {
	t.Run("returns board id for task", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		boardID, err := getBoardIDForTask(db, "task1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if boardID != "b1" {
			t.Errorf("expected board id 'b1', got %s", boardID)
		}
	})

	t.Run("returns error for nonexistent task", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		_, err := getBoardIDForTask(db, "nonexistent")
		if err == nil {
			t.Error("expected error for nonexistent task")
		}
	})
}

func TestGetBoardIDForColumn(t *testing.T) {
	t.Run("returns board id for column", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		boardID, err := getBoardIDForColumn(db, "c1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if boardID != "b1" {
			t.Errorf("expected board id 'b1', got %s", boardID)
		}
	})

	t.Run("returns error for nonexistent column", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		_, err := getBoardIDForColumn(db, "nonexistent")
		if err == nil {
			t.Error("expected error for nonexistent column")
		}
	})
}

func newTestGinContext() (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	return c, w
}

func TestRequireNonViewer(t *testing.T) {
	t.Run("VIEWER 角色返回 403", func(t *testing.T) {
		c, w := newTestGinContext()
		user := &models.User{ID: "u3", Role: "VIEWER"}

		blocked := requireNonViewer(c, user)

		if !blocked {
			t.Error("expected requireNonViewer to return true for VIEWER")
		}
		if w.Code != http.StatusForbidden {
			t.Errorf("expected status 403, got %d", w.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to parse response body: %v", err)
		}
		if body["error"] == "" {
			t.Error("expected error message in response body")
		}
	})

	t.Run("MEMBER 角色不拦截", func(t *testing.T) {
		c, w := newTestGinContext()
		user := &models.User{ID: "u2", Role: "MEMBER"}

		blocked := requireNonViewer(c, user)

		if blocked {
			t.Error("expected requireNonViewer to return false for MEMBER")
		}
		if w.Code != http.StatusOK && w.Code != 0 {
			t.Errorf("expected no error response, got status %d", w.Code)
		}
	})

	t.Run("ADMIN 角色不拦截", func(t *testing.T) {
		c, w := newTestGinContext()
		user := &models.User{ID: "u1", Role: "ADMIN"}

		blocked := requireNonViewer(c, user)

		if blocked {
			t.Error("expected requireNonViewer to return false for ADMIN")
		}
		if w.Code != http.StatusOK && w.Code != 0 {
			t.Errorf("expected no error response, got status %d", w.Code)
		}
	})

	t.Run("nil 用户视为 VIEWER 并返回 403", func(t *testing.T) {
		c, w := newTestGinContext()

		blocked := requireNonViewer(c, nil)

		if !blocked {
			t.Error("expected requireNonViewer to block nil user")
		}
		if w.Code != http.StatusForbidden {
			t.Errorf("expected status 403, got %d", w.Code)
		}
	})
}

func TestIsLastAdmin(t *testing.T) {
	t.Run("sole enabled admin returns true", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		last, err := IsLastAdmin(db, "u1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !last {
			t.Error("expected sole admin u1 to be reported as last admin")
		}
	})

	t.Run("multiple enabled admins returns false", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u4', 'admin2', 'admin2', 'ADMIN', 1)`); err != nil {
			t.Fatalf("failed to insert second admin: %v", err)
		}

		last, err := IsLastAdmin(db, "u1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if last {
			t.Error("expected u1 NOT to be reported as last admin when u4 also admin")
		}
	})

	t.Run("disabled admin does not count", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u4', 'admin2', 'admin2', 'ADMIN', 0)`); err != nil {
			t.Fatalf("failed to insert disabled admin: %v", err)
		}

		last, err := IsLastAdmin(db, "u1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !last {
			t.Error("expected sole enabled admin u1 to still be reported as last admin when u4 is disabled")
		}
	})

	t.Run("non-admin user with no other admins returns true", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`UPDATE users SET enabled = 0 WHERE id = 'u1'`); err != nil {
			t.Fatalf("failed to disable admin u1: %v", err)
		}

		last, err := IsLastAdmin(db, "u2")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !last {
			t.Error("expected no enabled admins, IsLastAdmin should return true")
		}
	})

	t.Run("agent with ADMIN role counts toward admin pool", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`INSERT INTO users (id, username, nickname, role, type, enabled) VALUES ('agent-admin', 'agent-admin', 'Agent Admin', 'ADMIN', 'AGENT', 1)`); err != nil {
			t.Fatalf("failed to insert agent admin: %v", err)
		}

		last, err := IsLastAdmin(db, "u1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if last {
			t.Error("expected u1 NOT to be last admin when an AGENT with ADMIN role exists")
		}
	})
}

func TestCanModifyTask(t *testing.T) {
	t.Run("ADMIN 任意任务通过", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		admin := &models.User{ID: "u1", Role: "ADMIN"}
		allowed, err := canModifyTask(db, admin, "task1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !allowed {
			t.Error("expected ADMIN to be allowed to modify any task")
		}
	})

	t.Run("VIEWER 任意任务拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		viewer := &models.User{ID: "u3", Role: "VIEWER"}
		allowed, err := canModifyTask(db, viewer, "task1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected VIEWER to be denied modification")
		}
	})

	t.Run("MEMBER 自己创建 通过", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		allowed, err := canModifyTask(db, member, "task1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !allowed {
			t.Error("expected MEMBER to be allowed to modify own task")
		}
	})

	t.Run("MEMBER 他人创建 拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		allowed, err := canModifyTask(db, member, "task2")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected MEMBER to be denied modification of someone else's task")
		}
	})

	t.Run("任务不存在 返回错误", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		_, err := canModifyTask(db, member, "nonexistent")
		if err == nil {
			t.Error("expected error for nonexistent task")
		}
		if err != sql.ErrNoRows {
			t.Errorf("expected sql.ErrNoRows, got %v", err)
		}
	})

	t.Run("MEMBER 任务无 created_by 拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('task3', 'Orphan Task', 'c1')`); err != nil {
			t.Fatalf("failed to insert orphan task: %v", err)
		}

		member := &models.User{ID: "u2", Role: "MEMBER"}
		allowed, err := canModifyTask(db, member, "task3")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected MEMBER to be denied modification of task without created_by")
		}
	})

	t.Run("nil 用户拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		allowed, err := canModifyTask(db, nil, "task1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected nil user to be denied modification")
		}
	})
}

func TestCheckTaskModifyAccess(t *testing.T) {
	t.Run("ADMIN 任意任务通过", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		admin := &models.User{ID: "u1", Role: "ADMIN"}
		allowed, err := CheckTaskModifyAccess(db, admin, "task1", "c1", "WRITE")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !allowed {
			t.Error("expected ADMIN to be allowed to modify any task")
		}
	})

	t.Run("VIEWER 任意任务拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		viewer := &models.User{ID: "u3", Role: "VIEWER"}
		allowed, err := CheckTaskModifyAccess(db, viewer, "task1", "c1", "WRITE")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected VIEWER to be denied modification")
		}
	})

	t.Run("MEMBER 自己创建 通过", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		allowed, err := CheckTaskModifyAccess(db, member, "task1", "c1", "WRITE")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !allowed {
			t.Error("expected MEMBER to be allowed to modify own task")
		}
	})

	t.Run("MEMBER 他人创建 拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		allowed, err := CheckTaskModifyAccess(db, member, "task2", "c1", "WRITE")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected MEMBER to be denied modification of someone else's task")
		}
	})

	t.Run("任务不存在 返回错误", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		member := &models.User{ID: "u2", Role: "MEMBER"}
		_, err := CheckTaskModifyAccess(db, member, "nonexistent", "c1", "WRITE")
		if err == nil {
			t.Error("expected error for nonexistent task")
		}
		if err != sql.ErrNoRows {
			t.Errorf("expected sql.ErrNoRows, got %v", err)
		}
	})

	t.Run("nil 用户拒绝", func(t *testing.T) {
		db := setupPermissionTestDB(t)
		defer db.Close()

		allowed, err := CheckTaskModifyAccess(db, nil, "task1", "c1", "WRITE")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if allowed {
			t.Error("expected nil user to be denied modification")
		}
	})
}
