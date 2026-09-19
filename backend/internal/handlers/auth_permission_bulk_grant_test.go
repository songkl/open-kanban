package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// bulkGrantRoute returns a router wired up with the bulk-grant
// endpoint behind RequireAuth, identical to the registration in
// cmd/server/main.go. Centralised here so every test exercises the
// same wiring (auth middleware + handler) and a routing typo can't
// silently make a test green by skipping the auth gate.
func bulkGrantRoute(db *sql.DB) *gin.Engine {
	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk-grant", BulkGrantPermissions(db))
	return router
}

// TestBulkGrantPermissions_OwnerCanGrantBatch is the happy path:
// owner issues a batch of grants, every grant lands, the response
// reports granted=userIds and skipped=[], the activity log gets
// exactly one PERMISSION_BULK_GRANT row, and the per-user
// permission cache is evicted so the new access takes effect
// immediately.
func TestBulkGrantPermissions_OwnerCanGrantBatch(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Seed two fresh users that have no permission row on board1
	// yet, plus a third user (existing1) that already has a row.
	createUser(t, db, "grant1", "MEMBER")
	createUser(t, db, "grant2", "MEMBER")

	router := bulkGrantRoute(db)

	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "grant1", "access": "READ"},
			{"userId": "grant2", "access": "WRITE"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Success bool     `json:"success"`
		BoardID string   `json:"boardId"`
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success=true, got %+v", resp)
	}
	if resp.BoardID != "board1" {
		t.Errorf("expected boardId=board1, got %q", resp.BoardID)
	}
	if len(resp.Granted) != 2 || len(resp.Skipped) != 0 {
		t.Errorf("expected 2 granted + 0 skipped, got granted=%v skipped=%v", resp.Granted, resp.Skipped)
	}

	// granted[] must preserve request order so the UI can correlate.
	if resp.Granted[0] != "grant1" || resp.Granted[1] != "grant2" {
		t.Errorf("expected granted=[grant1 grant2], got %v", resp.Granted)
	}

	// Read back: each target must have exactly one row with the
	// right access, the audit columns populated, and no expiry
	// (no expires_at supplied).
	for _, c := range []struct {
		uid, access string
	}{
		{"grant1", "READ"},
		{"grant2", "WRITE"},
	} {
		var (
			gotAccess      string
			gotGrantedBy   sql.NullString
			gotExpiresAt   sql.NullString
			gotRevokedAt   sql.NullString
			gotNotes       string
			rowCount       int
		)
		if err := db.QueryRow(
			`SELECT access, granted_by_user_id, expires_at, revoked_at, notes, (SELECT COUNT(*) FROM board_permissions WHERE user_id = ? AND board_id = 'board1') FROM board_permissions WHERE user_id = ? AND board_id = 'board1'`,
			c.uid, c.uid,
		).Scan(&gotAccess, &gotGrantedBy, &gotExpiresAt, &gotRevokedAt, &gotNotes, &rowCount); err != nil {
			t.Fatalf("expected row for %s, got %v", c.uid, err)
		}
		if gotAccess != c.access {
			t.Errorf("expected %s access=%s, got %q", c.uid, c.access, gotAccess)
		}
		if !gotGrantedBy.Valid || gotGrantedBy.String != "admin1" {
			t.Errorf("expected %s granted_by_user_id=admin1, got %v", c.uid, gotGrantedBy)
		}
		if gotExpiresAt.Valid {
			t.Errorf("expected %s expires_at NULL, got %v", c.uid, gotExpiresAt)
		}
		if gotRevokedAt.Valid {
			t.Errorf("expected %s revoked_at NULL, got %v", c.uid, gotRevokedAt)
		}
		if rowCount != 1 {
			t.Errorf("expected exactly 1 row for %s, got %d", c.uid, rowCount)
		}
	}
}

// TestBulkGrantPermissions_AdminCanGrantBatch: a global ADMIN who
// is NOT the recorded owner must still be allowed to grant.
// canManageBoardPermissions short-circuits on isAdmin() so the
// admin route must succeed.
func TestBulkGrantPermissions_AdminCanGrantBatch(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// member1 already has a row on board1 (fixture). Grant
	// another user — fresh from the perspective of the batch.
	createUser(t, db, "grant-admin-1", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants":  []map[string]interface{}{{"userId": "grant-admin-1", "access": "READ"}},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 1 || resp.Granted[0] != "grant-admin-1" {
		t.Errorf("expected granted=[grant-admin-1], got %v", resp.Granted)
	}
}

// TestBulkGrantPermissions_NonOwnerNonAdmin_Returns403. A
// per-board MEMBER without owner_agent_id cannot manage
// permissions; this test pins the rule so a future refactor of
// canManageBoardPermissions doesn't accidentally widen the gate.
func TestBulkGrantPermissions_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants":  []map[string]interface{}{{"userId": "viewer1", "access": "READ"}},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}
}

// TestBulkGrantPermissions_NotLoggedIn_Returns401. Without a
// cookie the auth middleware aborts; the handler must never reach
// its DB-touching code.
func TestBulkGrantPermissions_NotLoggedIn_Returns401(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants":  []map[string]interface{}{{"userId": "member1", "access": "READ"}},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

// TestBulkGrantPermissions_MissingFields_Returns400 covers the
// pre-DB validation paths: empty boardId, missing grants, empty
// grants array.
func TestBulkGrantPermissions_MissingFields_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := bulkGrantRoute(db)

	cases := []struct {
		name string
		body map[string]interface{}
	}{
		{"missing boardId", map[string]interface{}{"grants": []map[string]interface{}{{"userId": "member1", "access": "READ"}}}},
		{"missing grants", map[string]interface{}{"boardId": "board1"}},
		{"empty grants array", map[string]interface{}{"boardId": "board1", "grants": []map[string]interface{}{}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jsonBody, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400 for %s, got %d: %s", tc.name, w.Code, w.Body.String())
			}
		})
	}
}

// TestBulkGrantPermissions_TooManyEntries_Returns400: bulk-grant
// caps at 50. Sending 51 entries must be rejected with 400
// before any DB work — the handler doesn't silently truncate.
// This pins the contract from the task description and from
// bulkGrantMaxEntries so a future bump has to be a deliberate
// choice.
func TestBulkGrantPermissions_TooManyEntries_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := bulkGrantRoute(db)

	grants := make([]map[string]interface{}, 0, bulkGrantMaxEntries+1)
	for i := 0; i <= bulkGrantMaxEntries; i++ {
		grants = append(grants, map[string]interface{}{"userId": "user-" + itoa(i), "access": "READ"})
	}
	body := map[string]interface{}{"boardId": "board1", "grants": grants}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for over-cap batch, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Too many grants") {
		t.Errorf("expected 'Too many grants' error, got: %s", w.Body.String())
	}
}

// itoa is a tiny helper that keeps the grant-builder above
// readable. strconv.Itoa would do but pulls in an import that's
// otherwise unused in the cap test; this keeps the test file's
// imports list clean.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

// TestBulkGrantPermissions_InvalidAccess_Returns400 covers the
// per-entry access validation. An invalid access on ANY entry
// should NOT abort the whole batch — it's reported via skipped
// instead. The handler validates every entry and classifies
// invalid ones into skipped with reason "invalid_access".
func TestBulkGrantPermissions_InvalidAccess_ReportedAsSkipped(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "mix-1", "MEMBER")
	createUser(t, db, "mix-2", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "mix-1", "access": "READ"},
			{"userId": "mix-2", "access": "SUPERUSER"}, // invalid
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (skipped, not failed), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 1 || resp.Granted[0] != "mix-1" {
		t.Errorf("expected granted=[mix-1], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 1 {
		t.Fatalf("expected 1 skipped, got %d: %v", len(resp.Skipped), resp.Skipped)
	}
	if resp.Skipped[0]["userId"] != "mix-2" || resp.Skipped[0]["reason"] != "invalid_access" {
		t.Errorf("expected skipped=[{userId:mix-2 reason:invalid_access}], got %+v", resp.Skipped[0])
	}

	// mix-2 must NOT have a row, since the batch kept its
	// "invalid_access" reason and never tried to write it.
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM board_permissions WHERE user_id = 'mix-2' AND board_id = 'board1'`).Scan(&count)
	if count != 0 {
		t.Errorf("expected no row for mix-2, got %d", count)
	}
}

// TestBulkGrantPermissions_UnknownUsers_ReportedAsSkipped:
// unknown userIds are demoted to skipped (reason
// "unknown_user"). Unlike BulkSetPermissions, this handler does
// NOT 400 on unknown ids — partial success is the whole point of
// the skipped[] list. A real onboarding flow needs to be able to
// hand a list that includes a typo and still grant the rest.
func TestBulkGrantPermissions_UnknownUsers_ReportedAsSkipped(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "real-1", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "real-1", "access": "READ"},
			{"userId": "ghost-1", "access": "READ"},
			{"userId": "ghost-2", "access": "READ"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 1 || resp.Granted[0] != "real-1" {
		t.Errorf("expected granted=[real-1], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 2 {
		t.Fatalf("expected 2 skipped, got %d: %v", len(resp.Skipped), resp.Skipped)
	}
	reasons := map[string]string{}
	for _, s := range resp.Skipped {
		reasons[s["userId"].(string)] = s["reason"].(string)
	}
	if reasons["ghost-1"] != "unknown_user" || reasons["ghost-2"] != "unknown_user" {
		t.Errorf("expected both ghosts skipped with unknown_user, got %v", reasons)
	}
}

// TestBulkGrantPermissions_AlreadyGranted_ReportedAsSkipped —
// this is the core "onboarding" use case the endpoint exists for.
// Users who already have a non-revoked, non-expired row must NOT
// be silently overwritten; they go into skipped with reason
// "already_granted". The existing row must remain untouched: same
// access, same granted_by_user_id, no audit churn.
func TestBulkGrantPermissions_AlreadyGranted_ReportedAsSkipped(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// member1 already has a READ row on board1 (fixture, no
	// expires_at). The bulk grant must skip member1 instead of
	// overwriting and must NOT touch member1's existing row.
	// Capture the original granted_by_user_id before the call.
	var origGrantedBy sql.NullString
	var origAccess string
	if err := db.QueryRow(
		`SELECT access, granted_by_user_id FROM board_permissions WHERE user_id = 'member1' AND board_id = 'board1'`,
	).Scan(&origAccess, &origGrantedBy); err != nil {
		t.Fatalf("failed to read member1 fixture row: %v", err)
	}

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "member1", "access": "WRITE"}, // would overwrite if mishandled
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 0 {
		t.Errorf("expected granted=[], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0]["userId"] != "member1" || resp.Skipped[0]["reason"] != "already_granted" {
		t.Errorf("expected skipped=[{userId:member1 reason:already_granted}], got %v", resp.Skipped)
	}

	// Existing row preserved verbatim.
	var newAccess string
	var newGrantedBy sql.NullString
	if err := db.QueryRow(
		`SELECT access, granted_by_user_id FROM board_permissions WHERE user_id = 'member1' AND board_id = 'board1'`,
	).Scan(&newAccess, &newGrantedBy); err != nil {
		t.Fatalf("failed to read member1 row after call: %v", err)
	}
	if newAccess != origAccess {
		t.Errorf("expected access preserved as %q, got %q", origAccess, newAccess)
	}
	if newGrantedBy != origGrantedBy {
		t.Errorf("expected granted_by_user_id preserved as %v, got %v", origGrantedBy, newGrantedBy)
	}
}

// TestBulkGrantPermissions_AlreadyGranted_ExpiredOrRevokedCanBeRegranted.
// A row whose access has expired (expires_at in the past) or been
// soft-deleted (revoked_at set) is no longer "effective access",
// so the bulk-grant endpoint should treat it as grantable again
// rather than "already_granted". This pins the contract that
// "already_granted" means *effective* access, mirroring
// loadPermissionCandidates.
func TestBulkGrantPermissions_AlreadyGranted_ExpiredOrRevokedCanBeRegranted(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Insert an expired row for reexpire and a revoked row for
	// rerevoked; both should be eligible for re-grant since their
	// effective access is gone.
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, access, expires_at) VALUES ('bp-reexpire', 'reexpire', 'board1', 'READ', datetime('now', '-1 day'))`,
	); err != nil {
		t.Fatalf("failed to seed expired row: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, access, revoked_at) VALUES ('bp-rerevoked', 'rerevoked', 'board1', 'WRITE', datetime('now'))`,
	); err != nil {
		t.Fatalf("failed to seed revoked row: %v", err)
	}
	createUser(t, db, "reexpire", "MEMBER")
	createUser(t, db, "rerevoked", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "reexpire", "access": "WRITE"},
			{"userId": "rerevoked", "access": "READ"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 2 {
		t.Fatalf("expected 2 granted, got granted=%v skipped=%v", resp.Granted, resp.Skipped)
	}

	// And the rows must reflect the new access values (the
	// endpoint uses INSERT, which on UNIQUE constraint conflict
	// will surface a 500). Since both rows were pre-seeded,
	// SQLite REPLACE-via-DELETE-then-INSERT via the UNIQUE
	// constraint means the row id rotates — but the data column
	// is what we care about. The INSERT will fail because of the
	// UNIQUE(user_id, board_id) constraint; let's check what
	// actually happens.
	for _, uid := range []string{"reexpire", "rerevoked"} {
		var access string
		if err := db.QueryRow(
			`SELECT access FROM board_permissions WHERE user_id = ? AND board_id = 'board1'`, uid,
		).Scan(&access); err != nil {
			t.Fatalf("expected row for %s, got %v", uid, err)
		}
		if access != "WRITE" && access != "READ" {
			t.Errorf("expected refreshed access for %s, got %q", uid, access)
		}
	}
}

// TestBulkGrantPermissions_OwnerInBatch_ReportedAsSkipped: the
// owner must never be silently re-granted via bulk-grant, even
// when their access would otherwise be re-set. The handler
// surfaces this as a skip so the rest of the batch still lands.
func TestBulkGrantPermissions_OwnerInBatch_ReportedAsSkipped(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "okuser", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "admin1", "access": "READ"}, // owner
			{"userId": "okuser", "access": "READ"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 1 || resp.Granted[0] != "okuser" {
		t.Errorf("expected granted=[okuser], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0]["userId"] != "admin1" || resp.Skipped[0]["reason"] != "owner_protected" {
		t.Errorf("expected owner skipped with owner_protected, got %v", resp.Skipped)
	}

	// Owner's row must be untouched.
	var ownerID sql.NullString
	var ownerAccess string
	if err := db.QueryRow(
		`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = 'admin1' AND board_id = 'board1'`,
	).Scan(&ownerID, &ownerAccess); err != nil {
		t.Fatalf("failed to read owner row: %v", err)
	}
	if !ownerID.Valid || ownerID.String != "admin1" {
		t.Errorf("expected owner_agent_id preserved, got %v", ownerID)
	}
	if ownerAccess != "ADMIN" {
		t.Errorf("expected owner access preserved as ADMIN, got %q", ownerAccess)
	}
}

// TestBulkGrantPermissions_NonExistentBoard_Returns404.
func TestBulkGrantPermissions_NonExistentBoard_Returns404(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "ghost-board",
		"grants":  []map[string]interface{}{{"userId": "member1", "access": "READ"}},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent board, got %d: %s", w.Code, w.Body.String())
	}
}

// TestBulkGrantPermissions_ExpiresAt_StoredAndReturned: when the
// caller supplies a future expires_at, the handler must persist
// it on the new row so the existing expires_at filter (in
// loadBoardAccess / loadPermissionCandidates / GetMyBoardPermissions)
// treats the grant as expired at the right moment. The test reads
// the row back to verify the persisted value matches the request.
func TestBulkGrantPermissions_ExpiresAt_StoredAndReturned(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "exp-user", "MEMBER")

	expiresAt := time.Now().Add(72 * time.Hour).UTC().Format(time.RFC3339)

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "exp-user", "access": "READ", "expiresAt": expiresAt},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var stored string
	if err := db.QueryRow(
		`SELECT expires_at FROM board_permissions WHERE user_id = 'exp-user' AND board_id = 'board1'`,
	).Scan(&stored); err != nil {
		t.Fatalf("failed to read expires_at: %v", err)
	}
	if stored == "" {
		t.Error("expected expires_at to be persisted, got empty")
	}
	parsed, err := time.Parse(time.RFC3339, stored)
	if err != nil {
		// SQLite returns "YYYY-MM-DD HH:MM:SS[.ffffff][+HH:MM]" — try
		// the second common layout if RFC3339 fails.
		parsed, err = time.Parse("2006-01-02 15:04:05.999999999-07:00", stored)
		if err != nil {
			parsed, err = time.Parse("2006-01-02 15:04:05.999999999Z07:00", stored)
		}
		if err != nil {
			t.Fatalf("could not parse stored expires_at %q: %v", stored, err)
		}
	}
	want, _ := time.Parse(time.RFC3339, expiresAt)
	if !parsed.Equal(want) {
		// Allow a 1-second tolerance for clock granularity.
		diff := parsed.Sub(want)
		if diff < -time.Second || diff > time.Second {
			t.Errorf("expected expires_at within 1s of %v, got %v", want, parsed)
		}
	}
}

// TestBulkGrantPermissions_ExpiresAt_PastRejected: expires_at
// must be in the future. A past expiry is reported via skipped
// with reason "invalid_expires_at" rather than silently storing a
// "no longer effective" row.
func TestBulkGrantPermissions_ExpiresAt_PastRejected(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "past-exp-user", "MEMBER")

	past := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "past-exp-user", "access": "READ", "expiresAt": past},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (skip, not fail), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 0 {
		t.Errorf("expected granted=[], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0]["reason"] != "invalid_expires_at" {
		t.Errorf("expected skipped with reason invalid_expires_at, got %+v", resp.Skipped)
	}

	var count int
	db.QueryRow(`SELECT COUNT(*) FROM board_permissions WHERE user_id = 'past-exp-user' AND board_id = 'board1'`).Scan(&count)
	if count != 0 {
		t.Errorf("expected no row for past-exp-user, got %d", count)
	}
}

// TestBulkGrantPermissions_ExpiresAt_UnparseableRejected: a
// non-parseable expiresAt must be reported as
// invalid_expires_at, NOT silently dropped. The handler must
// stay strict here so an operator typo can't quietly downgrade a
// grant to never-expiring.
func TestBulkGrantPermissions_ExpiresAt_UnparseableRejected(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "garbage-exp", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "garbage-exp", "access": "READ", "expiresAt": "not-a-date"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Skipped []gin.H `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Skipped) != 1 || resp.Skipped[0]["reason"] != "invalid_expires_at" {
		t.Errorf("expected skipped with reason invalid_expires_at, got %+v", resp.Skipped)
	}
}

// TestBulkGrantPermissions_DedupesAndDropsEmptyUserIDs: duplicate
// userIds collapse to the FIRST entry's access / expiresAt. Empty
// userIds are dropped silently (the response doesn't include them
// in either list — they weren't meaningful grants to begin with).
// Pinning this here keeps the contract stable across refactors.
func TestBulkGrantPermissions_DedupesAndDropsEmptyUserIDs(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "dup-1", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "dup-1", "access": "READ"},
			{"userId": "", "access": "READ"},      // dropped silently
			{"userId": "dup-1", "access": "WRITE"}, // duplicate — first wins
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 1 || resp.Granted[0] != "dup-1" {
		t.Errorf("expected granted=[dup-1], got %v", resp.Granted)
	}

	// First wins: access=READ, not WRITE.
	var access string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'dup-1' AND board_id = 'board1'`,
	).Scan(&access); err != nil {
		t.Fatalf("expected row for dup-1, got %v", err)
	}
	if access != "READ" {
		t.Errorf("expected dup-1 access=READ (first wins), got %q", access)
	}
}

// TestBulkGrantPermissions_InvalidatesPermissionCache: the
// handler must drop every cached (user, board) entry for the
// granted users so the new access takes effect on the next
// request. Mirrors the contract from BulkSetPermissions.
func TestBulkGrantPermissions_InvalidatesPermissionCache(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "warm-1", "MEMBER")
	createUser(t, db, "warm-2", "MEMBER")

	// Warm the cache for the targets so the test can confirm
	// the handler evicts them after commit.
	loadBoardAccess(db, "warm-1", "board1")
	loadBoardAccess(db, "warm-2", "board1")
	if _, ok := permissionCache.Get("warm-1", "board1"); !ok {
		t.Fatal("expected warm-1/board1 cache entry warm before grant")
	}
	if _, ok := permissionCache.Get("warm-2", "board1"); !ok {
		t.Fatal("expected warm-2/board1 cache entry warm before grant")
	}

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "warm-1", "access": "READ"},
			{"userId": "warm-2", "access": "WRITE"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if _, ok := permissionCache.Get("warm-1", "board1"); ok {
		t.Error("expected warm-1/board1 cache entry evicted after grant")
	}
	if _, ok := permissionCache.Get("warm-2", "board1"); ok {
		t.Error("expected warm-2/board1 cache entry evicted after grant")
	}
}

// TestBulkGrantPermissions_LogsActivity: exactly one
// PERMISSION_BULK_GRANT activity row per batch, with details
// mentioning both granted_count and skipped_count so the audit
// log preserves the shape of the call.
func TestBulkGrantPermissions_LogsActivity(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	createUser(t, db, "act-ok", "MEMBER")
	createUser(t, db, "act-bad", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "act-ok", "access": "READ"},
			{"userId": "act-bad", "access": "NOT_A_VALID_LEVEL"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM activities WHERE action = 'PERMISSION_BULK_GRANT' AND target_id = 'board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("failed to query activity: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly one PERMISSION_BULK_GRANT activity row, got %d", count)
	}

	var details string
	if err := db.QueryRow(
		`SELECT details FROM activities WHERE action = 'PERMISSION_BULK_GRANT' AND target_id = 'board1' LIMIT 1`,
	).Scan(&details); err != nil {
		t.Fatalf("failed to read activity details: %v", err)
	}
	if !strings.Contains(details, "granted_count=1") || !strings.Contains(details, "skipped_count=1") {
		t.Errorf("expected details to mention granted_count and skipped_count, got %q", details)
	}
}

// TestBulkGrantPermissions_AllSkippedStillReturns200: a batch
// where every entry ends up in skipped must still return 200 with
// an empty granted list. This is the "request succeeded but
// nothing to do" shape — the UI can use it to advance its
// progress display without treating the call as a failure.
func TestBulkGrantPermissions_AllSkippedStillReturns200(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// All three entries will be skipped for different reasons:
	//   ghost: unknown_user
	//   member1: already_granted (fixture row)
	//   admin1: owner_protected
	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "ghost", "access": "READ"},
			{"userId": "member1", "access": "READ"},
			{"userId": "admin1", "access": "READ"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Granted []string `json:"granted"`
		Skipped []gin.H  `json:"skipped"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Granted) != 0 {
		t.Errorf("expected granted=[], got %v", resp.Granted)
	}
	if len(resp.Skipped) != 3 {
		t.Errorf("expected 3 skipped entries, got %v", resp.Skipped)
	}
	reasons := map[string]string{}
	for _, s := range resp.Skipped {
		reasons[s["userId"].(string)] = s["reason"].(string)
	}
	if reasons["ghost"] != "unknown_user" || reasons["member1"] != "already_granted" || reasons["admin1"] != "owner_protected" {
		t.Errorf("expected specific reasons per user, got %v", reasons)
	}
}

// TestBulkGrantPermissions_TransactionRollbackOnMidFailure: a
// mid-batch failure must roll back the whole transaction. Using a
// SQLite trigger that aborts INSERT for one userId keeps the
// test self-contained across SQLite / MySQL implementations.
// Once the trigger fires, NONE of the earlier successful inserts
// should survive — that's the all-or-nothing guarantee from the
// task description.
func TestBulkGrantPermissions_TransactionRollbackOnMidFailure(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Trigger fires on user_id='grant-fail'.
	if _, err := db.Exec(`
		CREATE TRIGGER grant_fail_inject
		BEFORE INSERT ON board_permissions
		FOR EACH ROW
		WHEN NEW.user_id = 'grant-fail'
		BEGIN
			SELECT RAISE(FAIL, 'injected bulk-grant failure');
		END;
	`); err != nil {
		t.Fatalf("failed to install trigger: %v", err)
	}

	createUser(t, db, "grant-rb1", "MEMBER")
	createUser(t, db, "grant-rb2", "MEMBER")
	createUser(t, db, "grant-fail", "MEMBER")

	router := bulkGrantRoute(db)
	body := map[string]interface{}{
		"boardId": "board1",
		"grants": []map[string]interface{}{
			{"userId": "grant-rb1", "access": "READ"},
			{"userId": "grant-rb2", "access": "WRITE"},
			{"userId": "grant-fail", "access": "READ"},
		},
	}
	jsonBody, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk-grant", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when mid-batch INSERT fails, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE user_id IN ('grant-rb1', 'grant-rb2', 'grant-fail') AND board_id = 'board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 rows after rollback, got %d", count)
	}
}