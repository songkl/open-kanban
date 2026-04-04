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

var tokenCache sync.Map

const tokenCacheDuration = 5 * time.Minute

func cleanupTokenCache() {
	for {
		time.Sleep(5 * time.Minute)
		now := time.Now()
		tokenCache.Range(func(key, value interface{}) bool {
			if entry, ok := value.(*cachedUser); ok && now.After(entry.expiresAt) {
				tokenCache.Delete(key)
			}
			return true
		})
	}
}

func ResetTokenCacheForTest() {
	tokenCache = sync.Map{}
}
