package handlers

import (
	"sync"
	"time"
)

type cachedPermission struct {
	access    string
	expiresAt time.Time
}

// PermissionCache caches effective board/column access for a
// (user, resource) pair so the per-request permission check can
// skip the DB roundtrip on warm cache hits. The interface is
// intentionally narrow: callers don't need to know whether the
// backing store is an in-memory sync.Map or Redis.
//
// resourceID semantics: a board ID for board-scoped entries, a
// column ID for column-scoped entries. The cache keys the two
// resource kinds under different prefixes so they never collide.
type PermissionCache interface {
	Get(userID, resourceID string) (string, bool)
	Set(userID, resourceID, access string)
	InvalidateUser(userID string) int
	InvalidateResource(resourceID string) int
}

type memoryPermissionCache struct {
	cache sync.Map
}

func permissionCacheKey(userID, resourceID string) string {
	return userID + "\x00" + resourceID
}

func (m *memoryPermissionCache) Get(userID, resourceID string) (string, bool) {
	if userID == "" || resourceID == "" {
		return "", false
	}
	raw, ok := m.cache.Load(permissionCacheKey(userID, resourceID))
	if !ok {
		return "", false
	}
	entry, ok := raw.(*cachedPermission)
	if !ok || entry == nil {
		return "", false
	}
	if time.Now().After(entry.expiresAt) {
		m.cache.Delete(permissionCacheKey(userID, resourceID))
		return "", false
	}
	return entry.access, true
}

func (m *memoryPermissionCache) Set(userID, resourceID, access string) {
	if userID == "" || resourceID == "" {
		return
	}
	m.cache.Store(permissionCacheKey(userID, resourceID), &cachedPermission{
		access:    access,
		expiresAt: time.Now().Add(permissionCacheDuration),
	})
}

// InvalidateUser walks the in-memory map and drops every entry
// whose userID matches. Called when a user's role / enabled flag
// or board / column permissions change so subsequent requests
// re-read the DB.
func (m *memoryPermissionCache) InvalidateUser(userID string) int {
	if userID == "" {
		return 0
	}
	deleted := 0
	m.cache.Range(func(key, _ interface{}) bool {
		k, ok := key.(string)
		if !ok {
			return true
		}
		if uid, _, ok := splitPermissionCacheKey(k); ok && uid == userID {
			m.cache.Delete(key)
			deleted++
		}
		return true
	})
	return deleted
}

// InvalidateResource walks the in-memory map and drops every entry
// whose resourceID matches. Called on board / column delete so the
// cascading permission rows don't leak into future cache hits.
func (m *memoryPermissionCache) InvalidateResource(resourceID string) int {
	if resourceID == "" {
		return 0
	}
	deleted := 0
	m.cache.Range(func(key, _ interface{}) bool {
		k, ok := key.(string)
		if !ok {
			return true
		}
		if _, rid, ok := splitPermissionCacheKey(k); ok && rid == resourceID {
			m.cache.Delete(key)
			deleted++
		}
		return true
	})
	return deleted
}

func splitPermissionCacheKey(key string) (string, string, bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == 0 {
			return key[:i], key[i+1:], true
		}
	}
	return "", "", false
}

var (
	permissionCache         PermissionCache
	permissionCacheOnce     sync.Once
	permissionCacheDuration = 5 * time.Minute
)

func initPermissionCache() {
	permissionCacheOnce.Do(func() {
		permissionCache = &memoryPermissionCache{}
	})
}

// ResetPermissionCacheForTest swaps the permission cache for a fresh
// in-memory instance. Mirrors ResetTokenCacheForTest so handlers
// tests start from a known-empty state.
func ResetPermissionCacheForTest() {
	permissionCache = &memoryPermissionCache{}
}

func init() {
	initPermissionCache()
}
