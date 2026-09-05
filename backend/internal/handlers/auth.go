package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/database"
	"open-kanban/internal/models"
	"open-kanban/internal/utils"
)

type cachedUser struct {
	user      *models.User
	expiresAt time.Time
}

type tokenCacheStore interface {
	Load(token string) (*cachedUser, bool)
	Store(token string, entry *cachedUser)
	Delete(token string)
	// DeleteByUserID drops every cached entry whose user.ID matches.
	// Called when an admin updates a user's role / enabled flag so
	// the target user sees the change on the next request without
	// having to log out and back in.
	DeleteByUserID(userID string) int
}

type memoryTokenCache struct {
	cache sync.Map
}

func (m *memoryTokenCache) Load(token string) (*cachedUser, bool) {
	if cached, ok := m.cache.Load(token); ok {
		if entry, ok := cached.(*cachedUser); ok {
			return entry, true
		}
	}
	return nil, false
}

func (m *memoryTokenCache) Store(token string, entry *cachedUser) {
	m.cache.Store(token, entry)
}

func (m *memoryTokenCache) Delete(token string) {
	m.cache.Delete(token)
}

// DeleteByUserID walks the in-memory map and drops every entry whose
// cached user matches userID. O(n) over the cache size, which is
// bounded by the number of live tokens (one per active session).
func (m *memoryTokenCache) DeleteByUserID(userID string) int {
	if userID == "" {
		return 0
	}
	deleted := 0
	m.cache.Range(func(key, value interface{}) bool {
		entry, ok := value.(*cachedUser)
		if !ok || entry == nil || entry.user == nil {
			return true
		}
		if entry.user.ID == userID {
			m.cache.Delete(key)
			deleted++
		}
		return true
	})
	return deleted
}

type redisTokenCacheStore struct {
	cache *utils.RedisTokenCache
}

func (r *redisTokenCacheStore) Load(token string) (*cachedUser, bool) {
	entry, found, err := r.cache.Load(token)
	if err != nil || !found {
		return nil, false
	}
	return &cachedUser{
		user: &models.User{
			ID:       entry.UserID,
			Username: entry.Username,
			Nickname: entry.Nickname,
			Avatar:   entry.Avatar,
			Type:     entry.Type,
			Role:     entry.Role,
			Enabled:  entry.Enabled,
		},
		expiresAt: entry.ExpiresAt,
	}, true
}

func (r *redisTokenCacheStore) Store(token string, entry *cachedUser) {
	utilsEntry := &utils.TokenCacheEntry{
		UserID:    entry.user.ID,
		Username:  entry.user.Username,
		Nickname:  entry.user.Nickname,
		Avatar:    entry.user.Avatar,
		Type:      entry.user.Type,
		Role:      entry.user.Role,
		Enabled:   entry.user.Enabled,
		ExpiresAt: entry.expiresAt,
	}
	r.cache.Store(token, utilsEntry, tokenCacheDuration)
}

func (r *redisTokenCacheStore) Delete(token string) {
	r.cache.Delete(token)
}

// DeleteByUserID SCANs Redis for `token:*` keys, fetches each, and
// drops the ones whose UserID matches. Acceptable for the typical
// session-count-per-user (1-3); if the deployment scales to millions
// of live tokens per user, swap in a `user:<id>:tokens` reverse
// index set on Store.
func (r *redisTokenCacheStore) DeleteByUserID(userID string) int {
	if userID == "" {
		return 0
	}
	keys, err := r.cache.ScanUserTokens(userID)
	if err != nil {
		return 0
	}
	deleted := 0
	for _, k := range keys {
		if err := r.cache.Delete(k); err == nil {
			deleted++
		}
	}
	return deleted
}

var (
	tokenCache         tokenCacheStore
	tokenCacheOnce     sync.Once
	tokenCacheDuration = 5 * time.Minute
)

var (
	avatarOptions = []string{
		"😊", "😎", "🙂", "😇", "🤗",
		"😸", "😻", "🌟", "💫", "✨",
		"🦊", "🐱", "🐶", "🐼", "🐨",
		"🦁", "🐯", "🦄", "🐲", "🦋",
		"🍎", "🍊", "🍓", "🥝", "🍇",
		"🌈", "☀️", "🌙", "⭐", "🔥",
	}
	salt     string
	saltOnce sync.Once
)

func getSalt() (string, error) {
	if salt != "" {
		return salt, nil
	}
	var err error
	saltOnce.Do(func() {
		if salt != "" {
			return
		}
		salt, err = loadOrGenerateSalt()
	})
	return salt, err
}

func SetSaltForTest(saltValue string) {
	salt = saltValue
}

func loadOrGenerateSalt() (string, error) {
	db, err := database.InitDB()
	if err != nil {
		return "", fmt.Errorf("failed to init database: %w", err)
	}
	defer db.Close()

	var existingSalt string
	err = db.QueryRow("SELECT value FROM app_config WHERE `key` = 'password_salt'").Scan(&existingSalt)
	if err == nil && len(existingSalt) >= 32 {
		return existingSalt, nil
	}

	saltBytes := make([]byte, 32)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}
	newSalt := hex.EncodeToString(saltBytes)

	_, err = db.Exec("REPLACE INTO app_config (`key`, value) VALUES ('password_salt', ?)", newSalt)
	if err != nil {
		return "", fmt.Errorf("failed to save salt: %w", err)
	}

	return newSalt, nil
}

func hashWithSalt(input string) (string, error) {
	salt, err := getSalt()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(salt + input))
	hash, err := bcrypt.GenerateFromPassword(digest[:], bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func verifyWithSalt(input, hash string) bool {
	salt, err := getSalt()
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(salt + input))
	err = bcrypt.CompareHashAndPassword([]byte(hash), digest[:])
	return err == nil
}

func HashPasswordWithSalt(password string) (string, error) {
	return hashWithSalt(password)
}

func VerifyPasswordWithSaltForTest(password, hash string) bool {
	return verifyWithSalt(password, hash)
}

func getCurrentUser(c *gin.Context, db *sql.DB) *models.User {
	var tokenKey string

	if authHeader := c.GetHeader("Authorization"); authHeader != "" {
		if strings.HasPrefix(authHeader, "Bearer ") {
			tokenKey = strings.TrimPrefix(authHeader, "Bearer ")
		}
	}

	if tokenKey == "" {
		var err error
		tokenKey, err = c.Cookie("kanban-token")
		if err != nil {
			return nil
		}
	}

	if cached, ok := tokenCache.Load(tokenKey); ok && time.Now().Before(cached.expiresAt) && cached.user.Enabled {
		return cached.user
	}

	var user models.User
	var token models.Token
	err := db.QueryRow(
		"SELECT t.expires_at, u.id, u.username, u.nickname, u.avatar, u.type, u.role, u.enabled FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.`key` = ?",
		tokenKey,
	).Scan(&token.ExpiresAt, &user.ID, &user.Username, &user.Nickname, &user.Avatar, &user.Type, &user.Role, &user.Enabled)
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

	tokenCache.Store(tokenKey, &cachedUser{
		user:      &user,
		expiresAt: time.Now().Add(tokenCacheDuration),
	})

	return &user
}

func RequireAuth(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if isAuthEnabled(db) {
			user := getCurrentUser(c, db)
			if user == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in or session has expired"})
				c.Abort()
				return
			}
			c.Set("user", user)
		}
		c.Next()
	}
}

func isAuthEnabled(db *sql.DB) bool {
	var authEnabled string
	err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'authEnabled'").Scan(&authEnabled)
	if err != nil {
		return true
	}
	return authEnabled != "0"
}

func OptionalAuth(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if user := getCurrentUser(c, db); user != nil {
			c.Set("user", user)
		}
		c.Next()
	}
}

func getUserFromContext(c *gin.Context) *models.User {
	if user, exists := c.Get("user"); exists {
		if u, ok := user.(*models.User); ok {
			return u
		}
	}
	return getCurrentUser(c, nil)
}

func initTokenCache() {
	tokenCacheOnce.Do(func() {
		redisCache, err := utils.NewRedisTokenCache()
		if err == nil && utils.IsRedisAvailable() {
			tokenCache = &redisTokenCacheStore{cache: redisCache}
		} else {
			tokenCache = &memoryTokenCache{}
		}
	})
}

// ResetTokenCacheForTest swaps the token cache for a fresh in-memory
// instance. Tests use it to start from a known-empty state.
func ResetTokenCacheForTest() {
	tokenCache = &memoryTokenCache{}
}

func init() {
	initTokenCache()
}
