package handlers

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"open-kanban/internal/models"
)

func TestEnforceTokenCacheLimit(t *testing.T) {
	ResetTokenCacheForTest()
	defer ResetTokenCacheForTest()

	for i := 0; i < maxTokenCacheSize+50; i++ {
		tokenCache.Store(string(rune(i)), &cachedUser{
			user: &models.User{
				ID:       "test-user",
				Username: "testuser",
				Nickname: "Test User",
				Enabled:  true,
			},
			expiresAt: time.Now().Add(5 * time.Minute),
		})
	}

	enforceTokenCacheLimit()

	size := GetTokenCacheSize()
	assert.LessOrEqual(t, size, maxTokenCacheSize, "Cache size should be limited to maxTokenCacheSize")
}

func TestEnforceTokenCacheLimitClearsExpired(t *testing.T) {
	ResetTokenCacheForTest()
	defer ResetTokenCacheForTest()

	user := &models.User{
		ID:       "test-user",
		Username: "testuser",
		Enabled:  true,
	}

	for i := 0; i < 50; i++ {
		tokenCache.Store(string(rune(i)), &cachedUser{
			user:      user,
			expiresAt: time.Now().Add(-1 * time.Minute),
		})
	}

	for i := 50; i < maxTokenCacheSize+50; i++ {
		tokenCache.Store(string(rune(i)), &cachedUser{
			user:      user,
			expiresAt: time.Now().Add(5 * time.Minute),
		})
	}

	enforceTokenCacheLimit()

	size := GetTokenCacheSize()
	assert.LessOrEqual(t, size, maxTokenCacheSize, "Cache size should be limited")

	hasExpired := false
	tokenCache.Range(func(key, value interface{}) bool {
		if entry, ok := value.(*cachedUser); ok {
			if time.Now().After(entry.expiresAt) {
				hasExpired = true
				return false
			}
		}
		return true
	})
	assert.False(t, hasExpired, "Expired entries should be cleaned up")
}

func TestGetTokenCacheSize(t *testing.T) {
	ResetTokenCacheForTest()
	defer ResetTokenCacheForTest()

	user := &models.User{
		ID:       "test-user",
		Username: "testuser",
		Enabled:  true,
	}

	assert.Equal(t, 0, GetTokenCacheSize())

	tokenCache.Store("key1", &cachedUser{
		user:      user,
		expiresAt: time.Now().Add(5 * time.Minute),
	})
	assert.Equal(t, 1, GetTokenCacheSize())

	tokenCache.Store("key2", &cachedUser{
		user:      user,
		expiresAt: time.Now().Add(5 * time.Minute),
	})
	assert.Equal(t, 2, GetTokenCacheSize())
}

func TestInvalidateTokenCacheForUser(t *testing.T) {
	ResetTokenCacheForTest()
	defer ResetTokenCacheForTest()

	user1 := &models.User{ID: "user1", Username: "user1", Enabled: true}
	user2 := &models.User{ID: "user2", Username: "user2", Enabled: true}

	tokenCache.Store("key1", &cachedUser{
		user:      user1,
		expiresAt: time.Now().Add(5 * time.Minute),
	})
	tokenCache.Store("key2", &cachedUser{
		user:      user2,
		expiresAt: time.Now().Add(5 * time.Minute),
	})
	tokenCache.Store("key3", &cachedUser{
		user:      user1,
		expiresAt: time.Now().Add(5 * time.Minute),
	})

	InvalidateTokenCacheForUser("user1")

	assert.Equal(t, 1, GetTokenCacheSize(), "Only user2's tokens should remain")
}

func TestTokenCacheConcurrency(t *testing.T) {
	ResetTokenCacheForTest()
	defer ResetTokenCacheForTest()

	user := &models.User{
		ID:       "test-user",
		Username: "testuser",
		Enabled:  true,
	}

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				key := string(rune(id*100 + j))
				tokenCache.Store(key, &cachedUser{
					user:      user,
					expiresAt: time.Now().Add(5 * time.Minute),
				})
				enforceTokenCacheLimit()
			}
		}(i)
	}
	wg.Wait()

	size := GetTokenCacheSize()
	assert.LessOrEqual(t, size, maxTokenCacheSize*2, "Cache size should be bounded under concurrent writes")
}
