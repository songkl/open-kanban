package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// setupTransferOwnershipDB extends the board-owner test fixture
// with the seed users / rows the TransferOwnership handler
// exercises. board1 is owned by admin1; member1 already has a
// permission row on board1 (a realistic "this user can be promoted"
// scenario); member2 has no row at all (so transferring to them
// must be rejected).
func setupTransferOwnershipDB(t *testing.T) *sql.DB {
	db := setupBoardOwnerDB(t)
	return db
}

func TestTransferOwnership_OwnerCanTransfer(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to transfer (200), got %d: %s", w.Code, w.Body.String())
	}

	// The new owner row must have owner_agent_id == member1 and
	// access = ADMIN. The old owner row must keep its row but
	// lose its owner_agent_id stamp.
	var newOwnerID sql.NullString
	var newAccess string
	if err := db.QueryRow(
		`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = 'member1' AND board_id = 'board1'`,
	).Scan(&newOwnerID, &newAccess); err != nil {
		t.Fatalf("failed to read new owner row: %v", err)
	}
	if !newOwnerID.Valid || newOwnerID.String != "member1" {
		t.Errorf("expected new owner_agent_id=member1, got %v", newOwnerID)
	}
	if newAccess != "ADMIN" {
		t.Errorf("expected new owner access=ADMIN, got %q", newAccess)
	}

	var oldOwnerID sql.NullString
	var oldAccess string
	if err := db.QueryRow(
		`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = 'admin1' AND board_id = 'board1'`,
	).Scan(&oldOwnerID, &oldAccess); err != nil {
		t.Fatalf("failed to read old owner row: %v", err)
	}
	if oldOwnerID.Valid {
		t.Errorf("expected old owner_agent_id cleared, got %v", oldOwnerID)
	}
	if oldAccess != "ADMIN" {
		t.Errorf("expected old owner access retained, got %q", oldAccess)
	}
}

func TestTransferOwnership_AdminCanTransfer(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	// Use a different admin (not the owner) to verify global
	// ADMINs can also drive the transfer.
	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected admin to transfer (200), got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member2-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_NonOwnerAdminRowCannotTransfer(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	// Promote member1 to a per-board ADMIN row but NOT the owner.
	// Per canManageBoardPermissions, a user with an ADMIN row but
	// no owner_agent_id stamp cannot manage permissions — and by
	// extension cannot transfer ownership. The transfer is a
	// meta-capability reserved to the owner / global admin.
	if _, err := db.Exec(
		`UPDATE board_permissions SET access = 'ADMIN' WHERE user_id = 'member1' AND board_id = 'board1'`,
	); err != nil {
		t.Fatalf("failed to promote member1 to board ADMIN: %v", err)
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member2",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for ADMIN-row non-owner, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_TargetWithoutPermission_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	// viewer1 exists but has no permission row on board1, so a
	// transfer targeting them must be rejected — the spec is
	// explicit that the new owner must already have at least one
	// board_permissions row on the board, otherwise the board
	// would end up with an owner stamp on a row that does not
	// exist ("无主").
	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "viewer1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when target user has no permission row, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_TargetSameAsCurrent_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "admin1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for self-transfer, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_NonExistentTarget_Returns404(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "ghost-user",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent target user, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_NonExistentBoard_Returns404(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "ghost-board",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent board, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_MissingFields_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId": "board1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing newOwnerUserId, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTransferOwnership_OldOwnerStillHasAdminAccessAfterTransfer(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to transfer (200), got %d: %s", w.Code, w.Body.String())
	}

	// Drop the cache so the next checkBoardAccess actually
	// re-reads the DB instead of returning the cached owner
	// short-circuit value. After the transfer:
	//   - member1 has owner_agent_id == member1, so the owner
	//     short-circuit grants them ADMIN access.
	//   - admin1 has owner_agent_id == NULL but access == ADMIN,
	//     so they still get ADMIN via the explicit access row.
	ResetPermissionCacheForTest()

	if !checkBoardAccess(db, "member1", "board1", "ADMIN", "MEMBER") {
		t.Error("expected new owner member1 to have ADMIN access via owner short-circuit")
	}
	if !checkBoardAccess(db, "admin1", "board1", "ADMIN", "ADMIN") {
		t.Error("expected former owner admin1 to still have ADMIN access via retained access row")
	}

	// IsBoardOwner must flip: member1 is now the owner, admin1 is
	// not.
	isOwner, err := IsBoardOwner(db, "member1", "board1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !isOwner {
		t.Error("expected member1 to be reported as the new board owner")
	}
	isOwner, err = IsBoardOwner(db, "admin1", "board1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if isOwner {
		t.Error("expected admin1 to no longer be reported as the board owner")
	}
}

func TestTransferOwnership_InvalidatesPermissionCache(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	// Warm the permission cache for both users on board1 to make
	// sure the handler's invalidation actually evicts them.
	loadBoardAccess(db, "admin1", "board1")
	loadBoardAccess(db, "member1", "board1")

	if _, ok := permissionCache.Get("admin1", "board1"); !ok {
		t.Fatal("expected admin1/board1 cache entry to be warm before transfer")
	}
	if _, ok := permissionCache.Get("member1", "board1"); !ok {
		t.Fatal("expected member1/board1 cache entry to be warm before transfer")
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to transfer (200), got %d: %s", w.Code, w.Body.String())
	}

	if _, ok := permissionCache.Get("admin1", "board1"); ok {
		t.Error("expected admin1/board1 cache entry to be evicted after transfer")
	}
	if _, ok := permissionCache.Get("member1", "board1"); ok {
		t.Error("expected member1/board1 cache entry to be evicted after transfer")
	}
}

func TestTransferOwnership_LogsActivity(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupTransferOwnershipDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/transfer-ownership", TransferOwnership(db))

	body := map[string]interface{}{
		"boardId":        "board1",
		"newOwnerUserId": "member1",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/transfer-ownership", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner to transfer (200), got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM activities WHERE action = 'PERMISSION_TRANSFER' AND target_id = 'board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("failed to query activity: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly one PERMISSION_TRANSFER activity row, got %d", count)
	}

	var details string
	if err := db.QueryRow(
		`SELECT details FROM activities WHERE action = 'PERMISSION_TRANSFER' AND target_id = 'board1' LIMIT 1`,
	).Scan(&details); err != nil {
		t.Fatalf("failed to read activity details: %v", err)
	}
	if details == "" {
		t.Error("expected PERMISSION_TRANSFER activity details to mention from/to users")
	}
}

func TestBulkSetPermissions_OwnerCanGrantBatch(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Add three fresh users that have no permission row on board1
	// yet so the bulk grant has real work to do (existing rows
	// would be silently overwritten, which is also valid, but
	// doesn't exercise the insert path).
	for _, id := range []string{"bulk1", "bulk2", "bulk3"} {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', 'MEMBER', 1, '', 'HUMAN')`,
			id, id, id,
		); err != nil {
			t.Fatalf("failed to seed user %s: %v", id, err)
		}
		if _, err := db.Exec(
			`INSERT INTO tokens (id, name, key, user_id) VALUES (?, 'default', ?, ?)`,
			"token-"+id, id+"-token", id,
		); err != nil {
			t.Fatalf("failed to seed token for %s: %v", id, err)
		}
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"bulk1", "bulk2", "bulk3"},
		"access":  "WRITE",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected owner bulk grant (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Success bool                     `json:"success"`
		BoardID string                   `json:"boardId"`
		Count   int                      `json:"count"`
		Granted []map[string]interface{} `json:"granted"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success=true, got %+v", resp)
	}
	if resp.BoardID != "board1" {
		t.Errorf("expected boardId=board1, got %q", resp.BoardID)
	}
	if resp.Count != 3 || len(resp.Granted) != 3 {
		t.Errorf("expected 3 granted rows, got count=%d granted=%d", resp.Count, len(resp.Granted))
	}

	// Read back: every user must now have a permission row with
	// access=WRITE on board1.
	for _, uid := range []string{"bulk1", "bulk2", "bulk3"} {
		var access string
		if err := db.QueryRow(
			`SELECT access FROM board_permissions WHERE user_id = ? AND board_id = 'board1'`,
			uid,
		).Scan(&access); err != nil {
			t.Fatalf("expected permission row for %s, got: %v", uid, err)
		}
		if access != "WRITE" {
			t.Errorf("expected %s access=WRITE, got %q", uid, access)
		}
	}
}

func TestBulkSetPermissions_AdminCanGrantBatch(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "member2"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected admin bulk grant (200), got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkSetPermissions_NonOwnerNonAdmin_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"viewer1"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-owner non-admin, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkSetPermissions_NotLoggedIn_Returns401(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for unauthenticated request, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkSetPermissions_MissingFields_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	cases := []struct {
		name string
		body map[string]interface{}
	}{
		{
			name: "missing boardId",
			body: map[string]interface{}{"userIds": []string{"member1"}, "access": "READ"},
		},
		{
			name: "missing userIds",
			body: map[string]interface{}{"boardId": "board1", "access": "READ"},
		},
		{
			name: "missing access",
			body: map[string]interface{}{"boardId": "board1", "userIds": []string{"member1"}},
		},
		{
			name: "empty userIds array",
			body: map[string]interface{}{"boardId": "board1", "userIds": []string{}, "access": "READ"},
		},
		{
			name: "only whitespace strings after dedupe",
			body: map[string]interface{}{"boardId": "board1", "userIds": []string{""}, "access": "READ"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jsonBody, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
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

func TestBulkSetPermissions_InvalidAccess_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1"},
		"access":  "SUPERUSER",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid access, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkSetPermissions_TooManyUsers_Returns400(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	ids := make([]string, 0, bulkPermissionMaxUsers+1)
	for i := 0; i <= bulkPermissionMaxUsers; i++ {
		ids = append(ids, "user-"+strconv.Itoa(i))
	}

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": ids,
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for over-cap batch, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Too many users") {
		t.Errorf("expected 'Too many users' error, got: %s", w.Body.String())
	}
}

func TestBulkSetPermissions_OwnerInBatch_Returns403(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"admin1", "member1"}, // admin1 is the owner
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 when owner in batch, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "owner") {
		t.Errorf("expected owner-protection error, got: %s", w.Body.String())
	}
}

func TestBulkSetPermissions_UnknownUsers_Returns400WithList(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "ghost1", "ghost2"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown users, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Error          string   `json:"error"`
		UnknownUserIDs []string `json:"unknownUserIds"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if len(resp.UnknownUserIDs) != 2 {
		t.Fatalf("expected 2 unknown ids, got %v", resp.UnknownUserIDs)
	}
	gotSet := map[string]bool{resp.UnknownUserIDs[0]: true, resp.UnknownUserIDs[1]: true}
	if !gotSet["ghost1"] || !gotSet["ghost2"] {
		t.Errorf("expected unknown ids to include ghost1+ghost2, got %v", resp.UnknownUserIDs)
	}
}

func TestBulkSetPermissions_NonExistentBoard_Returns404(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "ghost-board",
		"userIds": []string{"member1"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent board, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBulkSetPermissions_DedupesAndDropsEmptyIDs(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	// Duplicates and empty ids are filtered before the DB round
	// trip, so the response should report 2 grants even though the
	// request listed 4 entries.
	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "", "member1", "member2"},
		"access":  "WRITE",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 after dedupe, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Count != 2 {
		t.Errorf("expected count=2 after dedupe, got %d", resp.Count)
	}
}

func TestBulkSetPermissions_InvalidatesPermissionCache(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Warm the permission cache for both targets so the test can
	// confirm the handler evicts them after the grant commits.
	loadBoardAccess(db, "member1", "board1")
	loadBoardAccess(db, "member2", "board1")
	if _, ok := permissionCache.Get("member1", "board1"); !ok {
		t.Fatal("expected member1/board1 cache entry to be warm before grant")
	}
	if _, ok := permissionCache.Get("member2", "board1"); !ok {
		t.Fatal("expected member2/board1 cache entry to be warm before grant")
	}

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "member2"},
		"access":  "ADMIN",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if _, ok := permissionCache.Get("member1", "board1"); ok {
		t.Error("expected member1/board1 cache entry to be evicted after grant")
	}
	if _, ok := permissionCache.Get("member2", "board1"); ok {
		t.Error("expected member2/board1 cache entry to be evicted after grant")
	}
}

func TestBulkSetPermissions_LogsActivity(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "member2"},
		"access":  "WRITE",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
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
	if !strings.Contains(details, "user_count=2") || !strings.Contains(details, "access=WRITE") {
		t.Errorf("expected details to mention user_count and access, got %q", details)
	}
}

func TestBulkSetPermissions_PreservesOwnerRow(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	// Sending admin1 (the owner) in the batch must be rejected
	// 403 before any DB write. The owner's row — including the
	// owner_agent_id stamp and the explicit access — must remain
	// exactly as the fixture seeded it. The other member must not
	// gain a row either, since the whole batch is aborted.
	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"admin1", "viewer1"},
		"access":  "READ",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when owner is in batch, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "owner") {
		t.Errorf("expected owner-protection error, got: %s", w.Body.String())
	}

	var access string
	var ownerID sql.NullString
	if err := db.QueryRow(
		`SELECT access, owner_agent_id FROM board_permissions WHERE user_id = 'admin1' AND board_id = 'board1'`,
	).Scan(&access, &ownerID); err != nil {
		t.Fatalf("failed to read back admin1 row: %v", err)
	}
	if access != "ADMIN" {
		t.Errorf("expected admin1 access preserved as ADMIN, got %q", access)
	}
	if !ownerID.Valid || ownerID.String != "admin1" {
		t.Errorf("expected owner_agent_id preserved, got %v", ownerID)
	}

	var viewerCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE user_id = 'viewer1' AND board_id = 'board1'`,
	).Scan(&viewerCount); err != nil {
		t.Fatalf("failed to count viewer1 rows: %v", err)
	}
	if viewerCount != 0 {
		t.Errorf("expected no row created for viewer1 (batch was rejected), got %d", viewerCount)
	}
}

// createUser inserts a row into users with sensible defaults
// for the permission-handler tests. role defaults to "MEMBER"
// when the caller passes an empty string; pass an explicit
// role (e.g. "ADMIN", "VIEWER") to override. The inserted user
// is enabled, has avatar "", type "HUMAN", and a placeholder
// password — matches the schema used by setupBoardOwnerDB so
// the rows are indistinguishable from fixture rows in
// downstream queries.
func createUser(t *testing.T, db *sql.DB, id, role string) {
	t.Helper()
	if role == "" {
		role = "MEMBER"
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, role, enabled, avatar, type) VALUES (?, ?, ?, 'pass', ?, 1, '', 'HUMAN')`,
		id, id, id, role,
	); err != nil {
		t.Fatalf("createUser(%s, %s) failed: %v", id, role, err)
	}
}

// createBoard inserts a row into boards with the given id and
// name. The board is private (is_public = 0) by default — bulk
// permission tests don't care about visibility, but matching the
// setupBoardOwnerDB default keeps behaviour consistent across
// tests.
func createBoard(t *testing.T, db *sql.DB, id, name string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO boards (id, name) VALUES (?, ?)`,
		id, name,
	); err != nil {
		t.Fatalf("createBoard(%s, %s) failed: %v", id, name, err)
	}
}

// grantPermission inserts a row into board_permissions. ownerID
// is optional: pass "" when the row is not an owner row. The
// id parameter is the row's primary key — required so tests can
// delete a specific row later if they need to.
func grantPermission(t *testing.T, db *sql.DB, id, userID, boardID, ownerID, access string) {
	t.Helper()
	var ownerArg interface{}
	if ownerID != "" {
		ownerArg = ownerID
	}
	if _, err := db.Exec(
		`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES (?, ?, ?, ?, ?)`,
		id, userID, boardID, ownerArg, access,
	); err != nil {
		t.Fatalf("grantPermission(%s, %s, %s, %q, %s) failed: %v", id, userID, boardID, ownerID, access, err)
	}
}

// seedActivity inserts a row into activities with the action /
// target fields a test wants to assert against. userID defaults
// to "admin1" so activity-log assertions line up with the
// common caller used in these tests.
func seedActivity(t *testing.T, db *sql.DB, action, targetType, targetID string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO activities (id, user_id, action, target_type, target_id, details, ip_address, source) VALUES (?, 'admin1', ?, ?, ?, '', '', 'web')`,
		"act-"+action+"-"+targetID, action, targetType, targetID,
	); err != nil {
		t.Fatalf("seedActivity(%s, %s, %s) failed: %v", action, targetType, targetID, err)
	}
}

func TestBulkSetPermissions_UpsertExisting(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// member1 and member2 already have READ rows on board1 from
	// the fixture. Bulk-grant WRITE — REPLACE INTO must update
	// each row in place. The unique (user_id, board_id) index
	// also guarantees we never get duplicate rows for the same
	// pair, so the row count must stay at 1 per user after the
	// upsert.
	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "member2"},
		"access":  "WRITE",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected upsert (200), got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Count   int                      `json:"count"`
		Granted []map[string]interface{} `json:"granted"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Count != 2 || len(resp.Granted) != 2 {
		t.Errorf("expected 2 granted rows, got count=%d granted=%d", resp.Count, len(resp.Granted))
	}

	// Each target must have exactly one row with access=WRITE —
	// the upsert rewrote the existing READ rows instead of
	// inserting new ones.
	for _, uid := range []string{"member1", "member2"} {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM board_permissions WHERE user_id = ? AND board_id = 'board1'`, uid,
		).Scan(&count); err != nil {
			t.Fatalf("count failed for %s: %v", uid, err)
		}
		if count != 1 {
			t.Errorf("expected exactly 1 row for %s after upsert, got %d", uid, count)
		}
		var access string
		if err := db.QueryRow(
			`SELECT access FROM board_permissions WHERE user_id = ? AND board_id = 'board1'`, uid,
		).Scan(&access); err != nil {
			t.Fatalf("access read failed for %s: %v", uid, err)
		}
		if access != "WRITE" {
			t.Errorf("expected %s access=WRITE after upsert, got %q", uid, access)
		}
	}
}

func TestBulkSetPermissions_UpsertExisting_MixedNewAndExisting(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// member1 already has a READ row on board1; bulk-up2 is a
	// fresh user with no row yet. The bulk grant must upsert
	// member1 in place and insert a new row for bulk-up2.
	createUser(t, db, "bulk-up2", "MEMBER")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"member1", "bulk-up2"},
		"access":  "ADMIN",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// member1: existing row updated to ADMIN, count stays 1.
	var memberCount int
	var memberAccess string
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE user_id = 'member1' AND board_id = 'board1'`,
	).Scan(&memberCount); err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if memberCount != 1 {
		t.Errorf("expected member1 row count=1 after upsert, got %d", memberCount)
	}
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'member1' AND board_id = 'board1'`,
	).Scan(&memberAccess); err != nil {
		t.Fatalf("access read failed: %v", err)
	}
	if memberAccess != "ADMIN" {
		t.Errorf("expected member1 access=ADMIN, got %q", memberAccess)
	}

	// bulk-up2: new row inserted with access=ADMIN.
	var up2Access string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'bulk-up2' AND board_id = 'board1'`,
	).Scan(&up2Access); err != nil {
		t.Fatalf("expected new row for bulk-up2, got error: %v", err)
	}
	if up2Access != "ADMIN" {
		t.Errorf("expected bulk-up2 access=ADMIN, got %q", up2Access)
	}
}

func TestBulkSetPermissions_TransactionRollbackOnMidFailure(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer db.Close()

	// Install a trigger that aborts REPLACE INTO for one specific
	// user. We deliberately put the failing user LAST in the
	// batch so two earlier rows are attempted before the failure
	// fires — those rows must NOT survive the rollback. Using a
	// trigger keeps the test self-contained: no need to enable
	// PRAGMA foreign_keys or rely on a particular FK enforcement
	// mode, both of which differ between SQLite / MySQL.
	if _, err := db.Exec(`
		CREATE TRIGGER bulk_fail_inject_insert
		BEFORE INSERT ON board_permissions
		FOR EACH ROW
		WHEN NEW.user_id = 'fail-user'
		BEGIN
			SELECT RAISE(FAIL, 'injected FK failure');
		END;
	`); err != nil {
		t.Fatalf("failed to install BEFORE INSERT trigger: %v", err)
	}
	// SQLite implements REPLACE as DELETE + INSERT, so the
	// BEFORE INSERT trigger fires on conflict. Some drivers also
	// take the UPDATE path on REPLACE — guard both for safety.
	if _, err := db.Exec(`
		CREATE TRIGGER bulk_fail_inject_update
		BEFORE UPDATE ON board_permissions
		FOR EACH ROW
		WHEN NEW.user_id = 'fail-user'
		BEGIN
			SELECT RAISE(FAIL, 'injected FK failure');
		END;
	`); err != nil {
		t.Fatalf("failed to install BEFORE UPDATE trigger: %v", err)
	}

	// Seed two users that should succeed and one that the
	// trigger will reject.
	createUser(t, db, "bulk-rb1", "MEMBER")
	createUser(t, db, "bulk-rb2", "MEMBER")
	createUser(t, db, "fail-user", "MEMBER")

	router := gin.New()
	router.Use(RequireAuth(db))
	router.POST("/api/v1/auth/permissions/bulk", BulkSetPermissions(db))

	body := map[string]interface{}{
		"boardId": "board1",
		"userIds": []string{"bulk-rb1", "bulk-rb2", "fail-user"},
		"access":  "WRITE",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when mid-batch REPLACE fails, got %d: %s", w.Code, w.Body.String())
	}

	// None of the three target users must have a permission row
	// on board1 — the tx.Rollback() defer must have wiped the
	// earlier successful writes when the trigger fired on
	// fail-user. If even one row survives, the transaction is
	// not actually atomic and the test should fail loudly.
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM board_permissions WHERE user_id IN ('bulk-rb1', 'bulk-rb2', 'fail-user') AND board_id = 'board1'`,
	).Scan(&count); err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 permission rows after rollback, got %d", count)
	}

	// The owner row must also remain untouched — the failing
	// transaction must not have side-effects on other rows.
	var adminAccess string
	if err := db.QueryRow(
		`SELECT access FROM board_permissions WHERE user_id = 'admin1' AND board_id = 'board1'`,
	).Scan(&adminAccess); err != nil {
		t.Fatalf("failed to read admin1 row: %v", err)
	}
	if adminAccess != "ADMIN" {
		t.Errorf("expected admin1 access=ADMIN (untouched), got %q", adminAccess)
	}

	// Cache invalidation must NOT have run for the rolled-back
	// users — a partial flush would evict entries for grants
	// that never landed. The handler evicts only after a
	// successful commit, so the warm entries from the test setup
	// should still be present.
	loadBoardAccess(db, "bulk-rb1", "board1")
	if _, ok := permissionCache.Get("bulk-rb1", "board1"); !ok {
		t.Fatal("expected bulk-rb1/board1 cache entry to be warm before request")
	}

	// Reset and replay so we can verify the cache wasn't evicted.
	ResetPermissionCacheForTest()
	loadBoardAccess(db, "bulk-rb1", "board1")
	if _, ok := permissionCache.Get("bulk-rb1", "board1"); !ok {
		t.Fatal("expected bulk-rb1/board1 cache entry to be warm after re-warm")
	}

	req2, _ := http.NewRequest("POST", "/api/v1/auth/permissions/bulk", bytes.NewBuffer(jsonBody))
	req2.Header.Set("Content-Type", "application/json")
	req2.AddCookie(&http.Cookie{Name: "kanban-token", Value: "admin-token"})

	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, req2)

	// The second call also hits the trigger and returns 500.
	if w2.Code != http.StatusInternalServerError {
		t.Fatalf("expected second call to also return 500, got %d: %s", w2.Code, w2.Body.String())
	}

	// After the second failure, the rolled-back batch must still
	// have produced zero rows — the cache must not have been
	// evicted either.
	if _, ok := permissionCache.Get("bulk-rb1", "board1"); !ok {
		t.Error("expected bulk-rb1/board1 cache entry to survive the rolled-back failure")
	}
}
