package handlers

import (
	"testing"
	"time"

	"open-kanban/internal/models"
)

// SeedTokenCacheForTest installs an entry in the in-memory token
// cache so external tests can simulate "this user has been around
// for a while, their role is cached". The cache is keyed by token,
// so a test can target a specific session. Exported for the
// handlers_test package.
func SeedTokenCacheForTest(token, userID, role string) {
	if tokenCache == nil {
		tokenCache = &memoryTokenCache{}
	}
	tokenCache.Store(token, &cachedUser{
		user:      &models.User{ID: userID, Role: role, Type: "HUMAN"},
		expiresAt: time.Now().Add(5 * time.Minute),
	})
}

// PeekTokenCache exposes a read-only view of the token cache so
// tests in the handlers_test package can assert on invalidation
// without reaching into the private tokenCache variable directly.
func PeekTokenCache(token string) (*models.User, bool) {
	if tokenCache == nil {
		return nil, false
	}
	entry, ok := tokenCache.Load(token)
	if !ok || entry == nil {
		return nil, false
	}
	return entry.user, true
}

// TestMemoryTokenCacheDeleteByUserID exercises the in-memory
// implementation of DeleteByUserID directly so future refactors
// of the cache layout don't accidentally regress the multi-session
// invalidation path used by UpdateUser.
func TestMemoryTokenCacheDeleteByUserID(t *testing.T) {
	tokenCache = &memoryTokenCache{}
	t.Cleanup(func() { tokenCache = &memoryTokenCache{} })

	now := time.Now().Add(5 * time.Minute)
	// Two sessions for alice, one for bob.
	tokenCache.Store("alice-tok-1", &cachedUser{user: &models.User{ID: "alice", Role: "MEMBER"}, expiresAt: now})
	tokenCache.Store("alice-tok-2", &cachedUser{user: &models.User{ID: "alice", Role: "MEMBER"}, expiresAt: now})
	tokenCache.Store("bob-tok-1", &cachedUser{user: &models.User{ID: "bob", Role: "VIEWER"}, expiresAt: now})

	deleted := tokenCache.DeleteByUserID("alice")
	if deleted != 2 {
		t.Errorf("expected 2 entries deleted for alice, got %d", deleted)
	}
	if _, ok := tokenCache.Load("alice-tok-1"); ok {
		t.Error("alice-tok-1 should have been deleted")
	}
	if _, ok := tokenCache.Load("alice-tok-2"); ok {
		t.Error("alice-tok-2 should have been deleted")
	}
	if _, ok := tokenCache.Load("bob-tok-1"); !ok {
		t.Error("bob-tok-1 should still be present (different user)")
	}

	// Empty userID is a no-op (defensive: the caller must filter).
	if got := tokenCache.DeleteByUserID(""); got != 0 {
		t.Errorf("expected 0 deletes for empty userID, got %d", got)
	}
}
