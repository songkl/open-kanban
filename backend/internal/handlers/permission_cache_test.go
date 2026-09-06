package handlers

import (
	"testing"
	"time"
)

func TestPermissionCache_GetSet(t *testing.T) {
	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if _, ok := permissionCache.Get("u1", "b1"); ok {
		t.Fatal("expected empty cache to miss")
	}

	permissionCache.Set("u1", "b1", "WRITE")
	got, ok := permissionCache.Get("u1", "b1")
	if !ok {
		t.Fatal("expected hit after Set")
	}
	if got != "WRITE" {
		t.Errorf("expected WRITE, got %q", got)
	}

	if _, ok := permissionCache.Get("u1", "b2"); ok {
		t.Error("expected miss for different resource")
	}

	if _, ok := permissionCache.Get("u2", "b1"); ok {
		t.Error("expected miss for different user")
	}

	permissionCache.Set("u1", "b1", "ADMIN")
	got, _ = permissionCache.Get("u1", "b1")
	if got != "ADMIN" {
		t.Errorf("expected ADMIN after overwrite, got %q", got)
	}
}

func TestPermissionCache_InvalidateUser(t *testing.T) {
	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	permissionCache.Set("u1", "b1", "WRITE")
	permissionCache.Set("u1", "b2", "READ")
	permissionCache.Set("u1", "c1", "ADMIN")
	permissionCache.Set("u2", "b1", "WRITE")

	deleted := permissionCache.InvalidateUser("u1")
	if deleted != 3 {
		t.Errorf("expected 3 entries deleted for u1, got %d", deleted)
	}

	if _, ok := permissionCache.Get("u1", "b1"); ok {
		t.Error("expected u1:b1 to be invalidated")
	}
	if _, ok := permissionCache.Get("u1", "b2"); ok {
		t.Error("expected u1:b2 to be invalidated")
	}
	if _, ok := permissionCache.Get("u1", "c1"); ok {
		t.Error("expected u1:c1 to be invalidated")
	}
	if _, ok := permissionCache.Get("u2", "b1"); !ok {
		t.Error("expected u2:b1 to remain (different user)")
	}

	if got := permissionCache.InvalidateUser(""); got != 0 {
		t.Errorf("expected 0 deletes for empty userID, got %d", got)
	}
	if got := permissionCache.InvalidateUser("nonexistent"); got != 0 {
		t.Errorf("expected 0 deletes for unknown user, got %d", got)
	}
}

func TestPermissionCache_InvalidateResource(t *testing.T) {
	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	permissionCache.Set("u1", "b1", "WRITE")
	permissionCache.Set("u2", "b1", "READ")
	permissionCache.Set("u1", "b2", "ADMIN")

	deleted := permissionCache.InvalidateResource("b1")
	if deleted != 2 {
		t.Errorf("expected 2 entries deleted for b1, got %d", deleted)
	}

	if _, ok := permissionCache.Get("u1", "b1"); ok {
		t.Error("expected u1:b1 to be invalidated")
	}
	if _, ok := permissionCache.Get("u2", "b1"); ok {
		t.Error("expected u2:b1 to be invalidated")
	}
	if _, ok := permissionCache.Get("u1", "b2"); !ok {
		t.Error("expected u1:b2 to remain (different resource)")
	}

	if got := permissionCache.InvalidateResource(""); got != 0 {
		t.Errorf("expected 0 deletes for empty resourceID, got %d", got)
	}
}

func TestPermissionCache_TTLExpiry(t *testing.T) {
	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	originalDuration := permissionCacheDuration
	permissionCacheDuration = 50 * time.Millisecond
	t.Cleanup(func() { permissionCacheDuration = originalDuration })

	permissionCache.Set("u1", "b1", "WRITE")
	if _, ok := permissionCache.Get("u1", "b1"); !ok {
		t.Fatal("expected hit immediately after Set")
	}

	time.Sleep(80 * time.Millisecond)

	if _, ok := permissionCache.Get("u1", "b1"); ok {
		t.Error("expected miss after TTL expired")
	}
}

func TestCheckBoardAccess_CacheHit(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if !checkBoardAccess(db, "u2", "b1", "READ", "MEMBER") {
		t.Fatal("expected initial access on seeded permission")
	}

	if _, err := db.Exec(`DELETE FROM board_permissions WHERE user_id = 'u2' AND board_id = 'b1'`); err != nil {
		t.Fatalf("failed to delete seeded permission: %v", err)
	}
	if !checkBoardAccess(db, "u2", "b1", "READ", "MEMBER") {
		t.Error("expected cached positive access; second call should not re-read DB")
	}

	permissionCache.InvalidateUser("u2")
	if checkBoardAccess(db, "u2", "b1", "READ", "MEMBER") {
		t.Error("expected access to be revoked after cache invalidation + DB delete")
	}
}

func TestCheckBoardAccess_NegativeCacheHit(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if checkBoardAccess(db, "u3", "b1", "READ", "VIEWER") {
		t.Fatal("expected no access for u3 on first call")
	}

	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp_late', 'u3', 'b1', 'WRITE')`); err != nil {
		t.Fatalf("failed to insert late permission: %v", err)
	}
	if checkBoardAccess(db, "u3", "b1", "READ", "VIEWER") {
		t.Error("expected cached negative result; second call should not re-read DB")
	}

	permissionCache.InvalidateUser("u3")
	if !checkBoardAccess(db, "u3", "b1", "READ", "VIEWER") {
		t.Error("expected access after invalidation + DB insert")
	}
}

func TestCheckColumnAccess_CacheHit(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if !checkColumnAccess(db, "u2", "c1", "READ", "MEMBER") {
		t.Fatal("expected initial column access")
	}

	if _, err := db.Exec(`DELETE FROM column_permissions WHERE user_id = 'u2' AND column_id = 'c1'`); err != nil {
		t.Fatalf("failed to delete column permission: %v", err)
	}
	if !checkColumnAccess(db, "u2", "c1", "READ", "MEMBER") {
		t.Error("expected cached positive column access on second call")
	}

	permissionCache.InvalidateUser("u2")
	if checkColumnAccess(db, "u2", "c1", "READ", "MEMBER") {
		t.Error("expected column access to be revoked after invalidation")
	}
}

func TestGetEffectiveColumnAccessForBoard(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if _, err := db.Exec(`INSERT INTO columns (id, name, status, board_id) VALUES ('c2', 'Column 2', 'todo', 'b1')`); err != nil {
		t.Fatalf("failed to insert column c2: %v", err)
	}

	result, err := GetEffectiveColumnAccessForBoard(db, "u2", "b1", "MEMBER")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := result["c1"]; got != "READ" {
		t.Errorf("expected c1 → READ, got %q", got)
	}
	if got, ok := result["c2"]; !ok {
		t.Error("expected c2 in result map (explicit empty access)")
	} else if got != "" {
		t.Errorf("expected c2 → \"\", got %q", got)
	}

	if _, err := db.Exec(`DELETE FROM column_permissions WHERE user_id = 'u2' AND column_id = 'c1'`); err != nil {
		t.Fatalf("failed to delete c1 permission: %v", err)
	}
	if !checkColumnAccess(db, "u2", "c1", "READ", "MEMBER") {
		t.Error("expected cached READ for c1 after batch warm")
	}
}

func TestGetEffectiveColumnAccessForBoard_AdminShortCircuit(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	result, err := GetEffectiveColumnAccessForBoard(db, "u1", "b1", "ADMIN")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := result["c1"]; got != "ADMIN" {
		t.Errorf("expected ADMIN short-circuit, got %q", got)
	}
}

func TestGetEffectiveBoardAccess(t *testing.T) {
	db := setupPermissionTestDB(t)
	defer db.Close()

	ResetPermissionCacheForTest()
	t.Cleanup(ResetPermissionCacheForTest)

	if got := GetEffectiveBoardAccess(db, "u2", "b1", "MEMBER"); got != "WRITE" {
		t.Errorf("expected WRITE, got %q", got)
	}
	if got := GetEffectiveBoardAccess(db, "u3", "b1", "VIEWER"); got != "" {
		t.Errorf("expected empty access for u3, got %q", got)
	}
	if got := GetEffectiveBoardAccess(db, "u1", "b1", "ADMIN"); got != "ADMIN" {
		t.Errorf("expected ADMIN for admin role, got %q", got)
	}
}
