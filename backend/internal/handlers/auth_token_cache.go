package handlers

import (
	"sync"
	"time"

	"open-kanban/internal/models"
)

type cachedUser struct {
	user      *models.User
	expiresAt time.Time
}

var (
	tokenCache    = make(map[string]*cachedUser)
	tokenCacheMux sync.Mutex
)

const tokenCacheDuration = 5 * time.Minute

func cleanupTokenCache() {
	for {
		time.Sleep(5 * time.Minute)
		tokenCacheMux.Lock()
		now := time.Now()
		for key, entry := range tokenCache {
			if now.After(entry.expiresAt) {
				delete(tokenCache, key)
			}
		}
		tokenCacheMux.Unlock()
	}
}

func ResetTokenCacheForTest() {
	tokenCacheMux.Lock()
	defer tokenCacheMux.Unlock()
	tokenCache = make(map[string]*cachedUser)
}
