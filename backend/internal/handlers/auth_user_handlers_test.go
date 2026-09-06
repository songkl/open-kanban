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

// setupUserVisibilityDB seeds a multi-visibility fixture for the
// s-1030 "new user default visibility" tests:
//
//	admin1  (ADMIN HUMAN, token=admin1-token)
//	pub1    is_public=1
//	priv1   is_public=0
//
// Both boards get a column so downstream GetBoards / column tests
// can find matching rows. The schema mirrors the production
// migrations (notably the `is_public` column added by 004) so
// the queries handlers run against the test DB line up 1:1.
func setupUserVisibilityDB(t *testing.T) *sql.DB {
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
		type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
		role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
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
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES ('admin1', 'admin1', 'admin1', 'pass', 'ADMIN', 1, '', 'HUMAN')`,
	); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES ('tok-admin1', 'default', 'admin1-token', 'admin1', datetime('now'), datetime('now'))`,
	); err != nil {
		t.Fatalf("seed admin token: %v", err)
	}

	boards := []struct {
		id       string
		name     string
		isPublic bool
	}{
		{"pub1", "Public board", true},
		{"priv1", "Private board", false},
	}
	for _, b := range boards {
		if _, err := db.Exec(
			`INSERT INTO boards (id, name, deleted, is_public) VALUES (?, ?, 0, ?)`,
			b.id, b.name, b.isPublic,
		); err != nil {
			t.Fatalf("seed board %s: %v", b.id, err)
		}
		if _, err := db.Exec(
			`INSERT INTO columns (id, name, board_id) VALUES (?, ?, ?)`,
			"col-"+b.id, "Col "+b.name, b.id,
		); err != nil {
			t.Fatalf("seed column for %s: %v", b.id, err)
		}
	}

	// Grant admin1 ADMIN on every board so the createUser / createAgent
	// handlers see an enabled, privileged caller. The auto-grant code
	// paths under test create new users; admin1's own row keeps
	// auth checks happy without coupling us to global ADMIN
	// short-circuits.
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp-admin1-pub1', 'admin1', 'pub1', 'ADMIN'), ('bp-admin1-priv1', 'admin1', 'priv1', 'ADMIN')`,
	); err != nil {
		t.Fatalf("seed admin grants: %v", err)
	}

	return db
}

// countAccessRows returns the (board_id, access) pairs granted
// to userID. The two-element shape is just enough for the s-1030
// assertions: which board got a row, and at what access level.
func countAccessRows(t *testing.T, db *sql.DB, userID string) map[string]string {
	t.Helper()
	rows, err := db.Query(`SELECT board_id, access FROM board_permissions WHERE user_id = ?`, userID)
	if err != nil {
		t.Fatalf("query board_permissions: %v", err)
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var bid, access string
		if err := rows.Scan(&bid, &access); err != nil {
			t.Fatalf("scan board_permissions: %v", err)
		}
		out[bid] = access
	}
	return out
}

// TestRegisterNewUser_GetsPublicBoardRead guards the central
// promise of s-1030: a newly created HUMAN user (here, the MEMBER
// "alice" added via CreateUser) automatically receives READ
// access on every board marked is_public=1. The check is exact:
// one row, on the public board, at READ.
func TestRegisterNewUser_GetsPublicBoardRead(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/users", handlers.CreateUser(db))

	body := map[string]interface{}{
		"username": "alice",
		"nickname": "Alice",
		"password": "secret",
		"role":     "MEMBER",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Resolve the freshly minted user's id out of the response
	// so the assertion doesn't depend on generateID's exact
	// output.
	var resp struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.User.ID == "" {
		t.Fatalf("expected user.id in response, got %s", w.Body.String())
	}

	grants := countAccessRows(t, db, resp.User.ID)

	if got := grants["pub1"]; got != "READ" {
		t.Errorf("expected READ grant on pub1 (is_public=1), got %q (full grants: %v)", got, grants)
	}
	if _, ok := grants["priv1"]; ok {
		t.Errorf("expected no grant on priv1 (is_public=0), but found one (full grants: %v)", grants)
	}
	if len(grants) != 1 {
		t.Errorf("expected exactly 1 board_permissions row for new user, got %d: %v", len(grants), grants)
	}
}

// TestRegisterNewUser_PrivateBoardNoAccess covers the negative
// half of the visibility contract: when the only existing board
// is private, the freshly registered HUMAN user must end up
// with zero board_permissions rows.
//
// This is the regression guard for "we used to grant WRITE on
// every board" — a private board under that policy would leak
// to every new user, defeating the is_public flag.
func TestRegisterNewUser_PrivateBoardNoAccess(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	// Flip pub1 to private so the only board the user can see
	// is priv1, which they must not get a grant on.
	if _, err := db.Exec(`UPDATE boards SET is_public = 0 WHERE id = 'pub1'`); err != nil {
		t.Fatalf("flip pub1 to private: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/users", handlers.CreateUser(db))

	body := map[string]interface{}{
		"username": "bob",
		"nickname": "Bob",
		"role":     "VIEWER",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/users", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	grants := countAccessRows(t, db, resp.User.ID)
	if len(grants) != 0 {
		t.Errorf("expected zero board_permissions rows when only private boards exist, got %d: %v", len(grants), grants)
	}
}

// TestCreateAgent_StillGetsAdminAllBoards guards the explicit
// "AGENT behavior unchanged" clause in s-1030: agents are
// service accounts for the MCP server and need full reach across
// every board — public and private alike — so CreateAgent keeps
// the original "ADMIN on every board" loop untouched.
//
// If a future refactor accidentally narrows the agent grant to
// public-only, this test will catch it before the MCP server
// starts failing on private boards.
func TestCreateAgent_StillGetsAdminAllBoards(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents", handlers.CreateAgent(db))

	body := map[string]interface{}{
		"nickname": "mcp-bot",
		"avatar":   "🤖",
		"role":     "ADMIN",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Agent struct {
			ID string `json:"id"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	grants := countAccessRows(t, db, resp.Agent.ID)

	if got := grants["pub1"]; got != "ADMIN" {
		t.Errorf("expected ADMIN grant on pub1, got %q (full grants: %v)", got, grants)
	}
	if got := grants["priv1"]; got != "ADMIN" {
		t.Errorf("expected ADMIN grant on priv1, got %q (full grants: %v)", got, grants)
	}
	if len(grants) != 2 {
		t.Errorf("expected 2 board_permissions rows for new agent, got %d: %v", len(grants), grants)
	}
}
