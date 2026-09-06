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
