package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

var tokenCache sync.Map

type cachedUser struct {
	user      *models.User
	expiresAt time.Time
}

const tokenCacheDuration = 5 * time.Minute
const maxTokenCacheSize = 10000
const tokenCacheCleanupInterval = 1 * time.Minute

func GetTokens(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		rows, err := db.Query(
			"SELECT id, name, key, user_agent, expires_at, created_at, updated_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
			user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		var tokens []gin.H
		for rows.Next() {
			var t models.Token
			if err := rows.Scan(&t.ID, &t.Name, &t.Key, &t.UserAgent, &t.ExpiresAt, &t.CreatedAt, &t.UpdatedAt); err == nil {
				if len(t.Key) > 12 {
					t.Key = t.Key[:8] + "****" + t.Key[len(t.Key)-4:]
				}
				tokens = append(tokens, gin.H{
					"id":        t.ID,
					"name":      t.Name,
					"key":       t.Key,
					"userAgent": t.UserAgent,
					"expiresAt": t.ExpiresAt,
					"createdAt": t.CreatedAt,
					"updatedAt": t.UpdatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"tokens": tokens})
	}
}

func CreateToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if !checkRateLimit("token:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		var req CreateTokenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		name := req.Name
		if name == "" {
			name = "New Token"
		}

		_, err := db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, user_agent, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			tokenID, name, tokenKey, user.ID, c.Request.UserAgent(), req.ExpiresAt, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token": gin.H{
				"id":        tokenID,
				"name":      name,
				"key":       tokenKey,
				"userId":    user.ID,
				"expiresAt": req.ExpiresAt,
				"createdAt": time.Now(),
				"updatedAt": time.Now(),
			},
		})
	}
}

func UpdateToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		tokenID := c.Query("id")
		if tokenID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token ID is required"})
			return
		}

		var req struct {
			Name string `json:"name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = ? AND user_id = ?", tokenID, user.ID).Scan(&count)
		if err != nil || count == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token not found"})
			return
		}

		_, err = db.Exec("UPDATE tokens SET name = ?, updated_at = datetime('now') WHERE id = ?", req.Name, tokenID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func DeleteToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		tokenID := c.Query("id")
		if tokenID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token ID is required"})
			return
		}

		var tokenKey string
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = ? AND user_id = ?", tokenID, user.ID).Scan(&count)
		if err != nil || count == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token not found"})
			return
		}

		err = db.QueryRow("SELECT `key` FROM tokens WHERE id = ?", tokenID).Scan(&tokenKey)
		if err == nil && tokenKey != "" {
			tokenCache.Delete(tokenKey)
		}

		_, err = db.Exec("DELETE FROM tokens WHERE id = ?", tokenID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func getCurrentUserFromToken(db *sql.DB, tokenKey string) *models.User {
	if cached, ok := tokenCache.Load(tokenKey); ok {
		if entry, ok := cached.(*cachedUser); ok && time.Now().Before(entry.expiresAt) && entry.user.Enabled {
			return entry.user
		}
		tokenCache.Delete(tokenKey)
	}

	var user models.User
	var token models.Token
	err := db.QueryRow(
		"SELECT t.id, t.expires_at, u.id, u.username, u.nickname, u.avatar, u.type, u.role, u.enabled FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
		tokenKey,
	).Scan(&token.ID, &token.ExpiresAt, &user.ID, &user.Username, &user.Nickname, &user.Avatar, &user.Type, &user.Role, &user.Enabled)
	if err != nil {
		return nil
	}

	if token.ExpiresAt != nil && token.ExpiresAt.Before(time.Now()) {
		return nil
	}

	if !user.Enabled {
		return nil
	}

	db.Exec("UPDATE users SET last_active_at = datetime('now') WHERE id = ?", user.ID)

	enforceTokenCacheLimit()
	tokenCache.Store(tokenKey, &cachedUser{
		user:      &user,
		expiresAt: time.Now().Add(tokenCacheDuration),
	})

	return &user
}

func cleanupTokenCache(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(tokenCacheCleanupInterval):
			now := time.Now()
			tokenCache.Range(func(key, value interface{}) bool {
				if entry, ok := value.(*cachedUser); ok && now.After(entry.expiresAt) {
					tokenCache.Delete(key)
				}
				return true
			})
		}
	}
}

func ResetTokenCacheForTest() {
	tokenCache = sync.Map{}
}

func enforceTokenCacheLimit() {
	size := GetTokenCacheSize()
	if size >= maxTokenCacheSize {
		now := time.Now()
		deleted := 0
		targetDeletions := size - maxTokenCacheSize + 100
		tokenCache.Range(func(key, value interface{}) bool {
			if deleted >= targetDeletions {
				return false
			}
			if entry, ok := value.(*cachedUser); ok {
				if now.After(entry.expiresAt) || deleted < targetDeletions/2 {
					tokenCache.Delete(key)
					deleted++
				}
			}
			return true
		})
	}
}

func InvalidateTokenCacheForUser(userID string) {
	tokenCache.Range(func(key, value interface{}) bool {
		if entry, ok := value.(*cachedUser); ok && entry.user.ID == userID {
			tokenCache.Delete(key)
		}
		return true
	})
}

func GetTokenCacheSize() int {
	count := 0
	tokenCache.Range(func(key, value interface{}) bool {
		count++
		return true
	})
	return count
}
