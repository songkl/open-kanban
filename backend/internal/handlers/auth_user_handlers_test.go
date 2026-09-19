package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// TestRegisterNewUser_BoardGrantsAddsExplicitAccess guards the
// s-1253 contract for CreateUser: the public-board READ baseline
// from s-1030 still runs, AND the admin can attach explicit
// boardGrants — typically to grant the user WRITE on a private
// board they need to start working in.
//
// Without s-1253, an admin who wanted a brand-new user to have
// WRITE on a private board had no choice but to (1) create the
// user, (2) open the permissions modal, (3) grant WRITE. This
// folds those three steps into one POST.
func TestRegisterNewUser_BoardGrantsAddsExplicitAccess(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/users", handlers.CreateUser(db))

	body := map[string]interface{}{
		"username": "carol",
		"nickname": "Carol",
		"password": "secret",
		"role":     "MEMBER",
		"boardGrants": []map[string]string{
			{"boardId": "priv1", "access": "WRITE"},
		},
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
			ID          string `json:"id"`
			GrantedCount int   `json:"grantedCount"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.User.GrantedCount != 1 {
		t.Errorf("expected grantedCount=1, got %d", resp.User.GrantedCount)
	}

	grants := countAccessRows(t, db, resp.User.ID)
	// pub1 still gets the s-1030 public READ baseline.
	if got := grants["pub1"]; got != "READ" {
		t.Errorf("expected READ grant on pub1 (public baseline), got %q (full grants: %v)", got, grants)
	}
	// priv1 gets the explicit WRITE grant the admin asked for.
	if got := grants["priv1"]; got != "WRITE" {
		t.Errorf("expected WRITE grant on priv1, got %q (full grants: %v)", got, grants)
	}
	if len(grants) != 2 {
		t.Errorf("expected 2 board_permissions rows (pub1 READ + priv1 WRITE), got %d: %v", len(grants), grants)
	}
}

// TestCreateAgent_NoAutoGrants guards the s-1253 behaviour change:
// when CreateAgent is called WITHOUT boardGrants, the new agent
// must end up with zero board_permissions rows — neither the
// public board at any access level nor the private board at ADMIN.
//
// This is the negative half of the s-1253 contract. Prior to s-1253
// CreateAgent unconditionally inserted an ADMIN row on every
// existing board (public + private), which leaked private boards
// to every newly-minted agent. The new behaviour is "nothing by
// default; admins attach explicit grants via boardGrants or via
// the BoardPermissionsModal after the fact".
func TestCreateAgent_NoAutoGrants(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents", handlers.CreateAgent(db))

	body := map[string]interface{}{
		"nickname": "scoped-bot",
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
			ID           string `json:"id"`
			GrantedCount int    `json:"grantedCount"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Agent.GrantedCount != 0 {
		t.Errorf("expected grantedCount=0 when boardGrants omitted, got %d", resp.Agent.GrantedCount)
	}

	grants := countAccessRows(t, db, resp.Agent.ID)
	if len(grants) != 0 {
		t.Errorf("expected zero board_permissions rows when boardGrants omitted, got %d: %v", len(grants), grants)
	}
	if _, ok := grants["pub1"]; ok {
		t.Errorf("expected no grant on pub1, but found one (full grants: %v)", grants)
	}
	if _, ok := grants["priv1"]; ok {
		t.Errorf("expected no grant on priv1, but found one (full grants: %v)", grants)
	}
}

// TestCreateAgent_ExplicitBoardGrants guards the positive half of
// the s-1253 contract: when CreateAgent receives a boardGrants
// array, only those exact (boardId, access) pairs are inserted.
// The new agent must NOT receive auto-ADMIN on the omitted
// private board, and the access levels must reflect what the
// admin asked for (e.g. READ on pub1, ADMIN on priv1 — different
// access on different boards for the same agent).
//
// This is what "Agent 和 用户管理" promised: per-board roles at
// creation time, no implicit broad grants.
func TestCreateAgent_ExplicitBoardGrants(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents", handlers.CreateAgent(db))

	body := map[string]interface{}{
		"nickname": "scoped-bot",
		"avatar":   "🤖",
		"role":     "ADMIN",
		"boardGrants": []map[string]string{
			{"boardId": "pub1", "access": "READ"},
			{"boardId": "priv1", "access": "ADMIN"},
		},
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
			ID           string `json:"id"`
			GrantedCount int    `json:"grantedCount"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Agent.GrantedCount != 2 {
		t.Errorf("expected grantedCount=2, got %d", resp.Agent.GrantedCount)
	}

	grants := countAccessRows(t, db, resp.Agent.ID)
	if got := grants["pub1"]; got != "READ" {
		t.Errorf("expected READ grant on pub1, got %q (full grants: %v)", got, grants)
	}
	if got := grants["priv1"]; got != "ADMIN" {
		t.Errorf("expected ADMIN grant on priv1, got %q (full grants: %v)", got, grants)
	}
	if len(grants) != 2 {
		t.Errorf("expected exactly 2 board_permissions rows, got %d: %v", len(grants), grants)
	}
}

// TestCreateAgent_InvalidBoardGrant covers the validation half of
// the s-1253 contract: malformed boardGrants entries (unknown
// access, unknown boardId, empty values) are rejected before any
// user row is inserted, so an admin typo never leaves a half-applied
// grant behind.
func TestCreateAgent_InvalidBoardGrant(t *testing.T) {
	db := setupUserVisibilityDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/agents", handlers.CreateAgent(db))

	cases := []struct {
		name    string
		grants  []map[string]string
		wantSub string
	}{
		{
			name:    "unknown access is rejected",
			grants:  []map[string]string{{"boardId": "pub1", "access": "GOD"}},
			wantSub: "invalid access",
		},
		{
			name:    "unknown board is rejected",
			grants:  []map[string]string{{"boardId": "ghost-board", "access": "READ"}},
			wantSub: "unknown board ids",
		},
		{
			name:    "empty access is rejected",
			grants:  []map[string]string{{"boardId": "pub1", "access": ""}},
			wantSub: "boardId and access are required",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]interface{}{
				"nickname":    "bad-bot",
				"role":        "ADMIN",
				"boardGrants": tc.grants,
			}
			jsonBody, _ := json.Marshal(body)

			req, _ := http.NewRequest("POST", "/api/agents", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin1-token"})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), tc.wantSub) {
				t.Errorf("expected error to contain %q, got %s", tc.wantSub, w.Body.String())
			}

			// The agent row must have been rolled back so the
			// caller is not left with an orphan agent whose
			// name+token works but cannot reach any board.
			var orphanCount int
			if err := db.QueryRow(
				`SELECT COUNT(*) FROM users WHERE type='AGENT' AND nickname='bad-bot'`,
			).Scan(&orphanCount); err != nil {
				t.Fatalf("count orphan agents: %v", err)
			}
			if orphanCount != 0 {
				t.Errorf("expected orphan agent to be rolled back, found %d row(s)", orphanCount)
			}
		})
	}
}
