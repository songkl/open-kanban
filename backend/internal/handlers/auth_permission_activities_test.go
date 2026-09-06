package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/gin-gonic/gin"
)

// seedAuditActivity inserts an activity row with sensible defaults
// for the permission-audit tests. userID is required (the activity
// log is always attributed to a real user); the other fields default
// to "web" source and empty details/ip_address to keep the call
// sites compact.
func seedAuditActivity(t *testing.T, db *sql.DB, id, userID, action, targetType, targetID, targetTitle string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES (?, ?, ?, ?, ?, ?, '', '', 'web')`,
		id, userID, action, targetType, targetID, targetTitle,
	); err != nil {
		t.Fatalf("seedAuditActivity(%s, %s, %s, %s) failed: %v", id, action, targetType, targetID, err)
	}
}

// ensureAuditTables adds the auxiliary tables the audit
// endpoint's resourceId → boardId CASE expression references
// (comments, tasks). setupBoardOwnerDB only includes columns
// because none of the existing owner tests need a wider graph.
// The audit handler's CASE walks comments → tasks → columns for
// COMMENT-target rows and tasks → columns for TASK-target rows,
// so we mirror those tables here. Schema mirrors the production
// migrations just closely enough to keep CASE lookups happy.
func ensureAuditTables(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS tasks (
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
		)`); err != nil {
		t.Fatalf("ensureAuditTables: failed to ensure tasks: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS comments (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			author TEXT DEFAULT 'Anonymous',
			task_id TEXT NOT NULL,
			user_id TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
		)`); err != nil {
		t.Fatalf("ensureAuditTables: failed to ensure comments: %v", err)
	}
}

// setupAuditDB returns a freshly seeded SQLite with the board-owner
// fixture plus the auxiliary tables the audit endpoint needs. Use
// this in place of setupBoardOwnerDB when the test exercises the
// resourceId → boardId resolution path.
func setupAuditDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupBoardOwnerDB(t)
	ensureAuditTables(t, db)
	return db
}

// activityIDs returns the sorted list of activity IDs from the
// response payload so order-dependent assertions are deterministic.
func activityIDs(t *testing.T, body []byte) []string {
	t.Helper()
	var resp struct {
		Activities []Activity `json:"activities"`
		Total      int        `json:"total"`
		HasMore    bool       `json:"hasMore"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v: body=%s", err, body)
	}
	ids := make([]string, 0, len(resp.Activities))
	for _, a := range resp.Activities {
		ids = append(ids, a.ID)
	}
	sort.Strings(ids)
	return ids
}

func TestGetPermissionActivities_Unauthenticated_Returns401(t *testing.T) {
	ResetTokenCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for unauthenticated request, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetPermissionActivities_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	// member2 has READ on board1 but is NOT the owner, and is not a
	// global admin — must get 403.
	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member2-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetPermissionActivities_AdminSeesAllActions(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	// Seed activities across both boards. admin1 owns board1 but
	// board2 has no permissions; the global admin short-circuit must
	// still surface board2 rows.
	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke-board1", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer-board1", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-grant-board2", "admin1", "PERMISSION_GRANT", "BOARD", "board2", "Board Two")
	seedAuditActivity(t, db, "act-login-board1", "admin1", "LOGIN", "USER", "admin1", "admin")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Activities []Activity `json:"activities"`
		Total      int        `json:"total"`
		HasMore    bool       `json:"hasMore"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	// Default actions = PERMISSION_GRANT/REVOKE/TRANSFER. Admin must
	// see all four matching rows, NOT the LOGIN row.
	if resp.Total != 4 {
		t.Errorf("expected total=4 for default action filter, got %d", resp.Total)
	}

	wantActions := map[string]bool{}
	for _, a := range resp.Activities {
		wantActions[a.Action] = true
	}
	if !wantActions["PERMISSION_GRANT"] || !wantActions["PERMISSION_REVOKE"] || !wantActions["PERMISSION_TRANSFER"] {
		t.Errorf("expected PERMISSION_GRANT/REVOKE/TRANSFER in response, got actions: %v", wantActions)
	}
	if wantActions["LOGIN"] {
		t.Error("LOGIN must NOT appear in the permission-audit response")
	}
}

func TestGetPermissionActivities_FilterByGrantOnly(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke-board1", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer-board1", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Activities []Activity `json:"activities"`
		Total      int        `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Total != 1 {
		t.Errorf("expected total=1 for PERMISSION_GRANT filter, got %d", resp.Total)
	}
	if len(resp.Activities) != 1 || resp.Activities[0].Action != "PERMISSION_GRANT" {
		t.Errorf("expected single PERMISSION_GRANT activity, got %+v", resp.Activities)
	}
	if resp.Activities[0].ID != "act-grant-board1" {
		t.Errorf("expected id=act-grant-board1, got %s", resp.Activities[0].ID)
	}
}

func TestGetPermissionActivities_FilterByRevokeOnly(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke-board1", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer-board1", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_REVOKE", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Activities []Activity `json:"activities"`
		Total      int        `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Total != 1 {
		t.Errorf("expected total=1 for PERMISSION_REVOKE filter, got %d", resp.Total)
	}
	if len(resp.Activities) != 1 || resp.Activities[0].Action != "PERMISSION_REVOKE" {
		t.Errorf("expected single PERMISSION_REVOKE activity, got %+v", resp.Activities)
	}
}

func TestGetPermissionActivities_FilterByTransferOnly(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke-board1", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer-board1", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_TRANSFER", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Activities []Activity `json:"activities"`
		Total      int        `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Total != 1 {
		t.Errorf("expected total=1 for PERMISSION_TRANSFER filter, got %d", resp.Total)
	}
	if len(resp.Activities) != 1 || resp.Activities[0].Action != "PERMISSION_TRANSFER" {
		t.Errorf("expected single PERMISSION_TRANSFER activity, got %+v", resp.Activities)
	}
}

func TestGetPermissionActivities_FilterMultipleActions(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke-board1", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer-board1", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-login-board1", "admin1", "LOGIN", "USER", "admin1", "admin")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	// ?actions=PERMISSION_GRANT,PERMISSION_TRANSFER returns just the
	// GRANT and TRANSFER rows; REVOKE and LOGIN are filtered out.
	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT,PERMISSION_TRANSFER", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	got := activityIDs(t, w.Body.Bytes())
	want := []string{"act-grant-board1", "act-transfer-board1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("expected activity ids %v, got %v", want, got)
	}
}

func TestGetPermissionActivities_InvalidAction_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT,NOT_A_REAL_ACTION", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unsupported action, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetPermissionActivities_BoardOwnerSeesOnlyOwnBoard(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	// Promote member1 to owner of board2 — admin1 keeps board1.
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = NULL WHERE user_id = 'admin1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to clear prior owner: %v", err)
	}
	// board2 has no permission rows in the fixture, so INSERT a
	// row for member1 with owner_agent_id=member1 to make them the
	// owner of board2.
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES ('bp-member1-board2', 'member1', 'board2', 'member1', 'ADMIN')`,
	); err != nil {
		t.Fatalf("failed to seed member1 as board2 owner: %v", err)
	}
	// Promote member1 to owner of board1 as well so we can verify
	// the union of owned boards is honored. The board_permissions
	// table has UNIQUE(user_id, board_id) so we UPDATE the existing
	// row rather than INSERT a duplicate.
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to board1 owner: %v", err)
	}
	ResetPermissionCacheForTest()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-grant-board2", "admin1", "PERMISSION_GRANT", "BOARD", "board2", "Board Two")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for board owner, got %d: %s", w.Code, w.Body.String())
	}

	got := activityIDs(t, w.Body.Bytes())
	want := []string{"act-grant-board1", "act-grant-board2"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("expected both owned-board activities %v, got %v", want, got)
	}
}

func TestGetPermissionActivities_BoardOwnerExcludesForeignRows(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	// member1 owns ONLY board1; admin1 owns board1 in the fixture
	// but we strip that so member1 is the sole owner of board1.
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = NULL WHERE user_id = 'admin1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to clear admin1 owner flag: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to board1 owner: %v", err)
	}
	ResetPermissionCacheForTest()

	seedAuditActivity(t, db, "act-grant-board1", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-grant-board2", "admin1", "PERMISSION_GRANT", "BOARD", "board2", "Board Two")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for board owner, got %d: %s", w.Code, w.Body.String())
	}

	got := activityIDs(t, w.Body.Bytes())
	want := []string{"act-grant-board1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("expected only owned-board activity %v, got %v (board2 must be hidden)", want, got)
	}
}

func TestGetPermissionActivities_ColumnTargetResolvesToBoard(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	// Seed a column under board1, then a PERMISSION_GRANT activity
	// with target_type=COLUMN. member1 (after promotion) owns
	// board1, so the CASE expression must resolve the column back
	// to board1 and surface the row.
	if _, err := db.Exec(
		`INSERT INTO columns (id, name, board_id) VALUES ('col-1', 'Col One', 'board1')`,
	); err != nil {
		t.Fatalf("failed to seed column: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = NULL WHERE user_id = 'admin1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to clear admin1 owner flag: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE board_permissions SET owner_agent_id = 'member1' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to board1 owner: %v", err)
	}
	ResetPermissionCacheForTest()

	seedAuditActivity(t, db, "act-grant-col1", "admin1", "PERMISSION_GRANT", "COLUMN", "col-1", "Col One")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities?actions=PERMISSION_GRANT", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	got := activityIDs(t, w.Body.Bytes())
	want := []string{"act-grant-col1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("expected COLUMN-target activity to resolve to board1 and be visible to owner, got %v", got)
	}
}

func TestGetPermissionActivities_EmptyActionsDefaultsToThree(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupAuditDB(t)
	defer db.Close()

	// Seed all four PERMISSION actions. PERMISSION_BULK_GRANT must
	// NOT appear in the default response — only the three canonical
	// PERMISSION actions are returned when ?actions= is omitted.
	seedAuditActivity(t, db, "act-grant", "admin1", "PERMISSION_GRANT", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-revoke", "admin1", "PERMISSION_REVOKE", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-transfer", "admin1", "PERMISSION_TRANSFER", "BOARD", "board1", "Board One")
	seedAuditActivity(t, db, "act-bulk", "admin1", "PERMISSION_BULK_GRANT", "BOARD", "board1", "Board One")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/activities", GetPermissionActivities(db))

	req, _ := http.NewRequest("GET", "/api/v1/activities", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	got := activityIDs(t, w.Body.Bytes())
	want := []string{"act-grant", "act-revoke", "act-transfer"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("expected default action set %v, got %v (PERMISSION_BULK_GRANT must be excluded)", want, got)
	}
}
