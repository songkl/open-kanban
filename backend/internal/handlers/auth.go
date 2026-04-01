package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"open-kanban/internal/database"
	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

type rateLimitEntry struct {
	count     int
	resetTime time.Time
}

var (
	rateLimitMap  = make(map[string]*rateLimitEntry)
	rateLimitMux  sync.Mutex
	rateLimitOpts = struct {
		maxRequests int
		windowSecs  int
	}{
		maxRequests: 5,
		windowSecs:  60,
	}
)

type globalRateLimitEntry struct {
	count     int
	resetTime time.Time
}

var (
	globalRateLimitMap  = make(map[string]*globalRateLimitEntry)
	globalRateLimitMux  sync.Mutex
	globalRateLimitOpts = struct {
		maxRequests int
		windowSecs  int
	}{
		maxRequests: 100,
		windowSecs:  60,
	}
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

func init() {
	go cleanupRateLimitMap()
	go cleanupGlobalRateLimitMap()
	go cleanupTokenCache()
}

func cleanupRateLimitMap() {
	for {
		time.Sleep(5 * time.Minute)
		rateLimitMux.Lock()
		now := time.Now()
		for key, entry := range rateLimitMap {
			if now.After(entry.resetTime) {
				delete(rateLimitMap, key)
			}
		}
		rateLimitMux.Unlock()
	}
}

func cleanupGlobalRateLimitMap() {
	for {
		time.Sleep(5 * time.Minute)
		globalRateLimitMux.Lock()
		now := time.Now()
		for key, entry := range globalRateLimitMap {
			if now.After(entry.resetTime) {
				delete(globalRateLimitMap, key)
			}
		}
		globalRateLimitMux.Unlock()
	}
}

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

func checkRateLimit(key string) bool {
	rateLimitMux.Lock()
	defer rateLimitMux.Unlock()

	now := time.Now()
	entry, exists := rateLimitMap[key]

	if !exists || now.After(entry.resetTime) {
		rateLimitMap[key] = &rateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(rateLimitOpts.windowSecs) * time.Second),
		}
		return true
	}

	if entry.count >= rateLimitOpts.maxRequests {
		return false
	}

	entry.count++
	return true
}

func checkGlobalRateLimit(key string) bool {
	globalRateLimitMux.Lock()
	defer globalRateLimitMux.Unlock()

	now := time.Now()
	entry, exists := globalRateLimitMap[key]

	if !exists || now.After(entry.resetTime) {
		globalRateLimitMap[key] = &globalRateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(globalRateLimitOpts.windowSecs) * time.Second),
		}
		return true
	}

	if entry.count >= globalRateLimitOpts.maxRequests {
		return false
	}

	entry.count++
	return true
}

// GlobalRateLimitMiddleware provides per-IP rate limiting for all API routes
func GlobalRateLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Use IP address as the rate limit key
		key := "global:" + c.ClientIP()

		if !checkGlobalRateLimit(key) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			c.Abort()
			return
		}

		c.Next()
	}
}

var (
	avatarOptions = []string{}
	salt          string
	saltOnce      sync.Once
)

// getSalt returns the application salt, generating one if it doesn't exist
func getSalt() (string, error) {
	var err error
	saltOnce.Do(func() {
		salt, err = loadOrGenerateSalt()
	})
	return salt, err
}

func loadOrGenerateSalt() (string, error) {
	db, err := database.InitDB()
	if err != nil {
		return "", fmt.Errorf("failed to init database: %w", err)
	}
	defer db.Close()

	var existingSalt string
	err = db.QueryRow("SELECT value FROM app_config WHERE key = 'password_salt'").Scan(&existingSalt)
	if err == nil && len(existingSalt) >= 32 {
		return existingSalt, nil
	}

	saltBytes := make([]byte, 32)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}
	newSalt := hex.EncodeToString(saltBytes)

	_, err = db.Exec("INSERT OR REPLACE INTO app_config (key, value) VALUES ('password_salt', ?)", newSalt)
	if err != nil {
		return "", fmt.Errorf("failed to save salt: %w", err)
	}

	return newSalt, nil
}

// hashWithSalt hashes input with the application salt
func hashWithSalt(input string) (string, error) {
	salt, err := getSalt()
	if err != nil {
		return "", err
	}
	combined := salt + input
	hash, err := bcrypt.GenerateFromPassword([]byte(combined), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// verifyWithSalt verifies input against a hash using the application salt
func verifyWithSalt(input, hash string) bool {
	salt, err := getSalt()
	if err != nil {
		return false
	}
	combined := salt + input
	err = bcrypt.CompareHashAndPassword([]byte(hash), []byte(combined))
	return err == nil
}

// HashPasswordWithSalt hashes a password with the application salt (exported for CLI use)
func HashPasswordWithSalt(password string) (string, error) {
	return hashWithSalt(password)
}

// LoginRequest represents login request body
type LoginRequest struct {
	Nickname string `json:"nickname"`
	Password string `json:"password"`
	Avatar   string `json:"avatar"`
	Type     string `json:"type"`
}

// InitRequest represents first-time initialization request
type InitRequest struct {
	Nickname          string `json:"nickname"`
	Password          string `json:"password"`
	Avatar            string `json:"avatar"`
	AllowRegistration bool   `json:"allowRegistration"`
	RequirePassword   bool   `json:"requirePassword"`
	AuthEnabled       *bool  `json:"authEnabled"`
}

// Init handles first-time setup (only works when no users exist)
func Init(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check if any users exist
		var userCount int
		err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "检查用户失败"})
			return
		}

		if userCount > 0 {
			c.JSON(http.StatusForbidden, gin.H{"error": "系统已初始化，无法再次设置"})
			return
		}

		var req InitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式错误"})
			return
		}

		if req.Nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}

		// Save app config
		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', ?)",
			map[bool]string{true: "true", false: "false"}[req.AllowRegistration],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
			return
		}

		requirePassword := req.Password != ""
		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('requirePassword', ?)",
			map[bool]string{true: "true", false: "false"}[requirePassword],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
			return
		}

		authEnabled := true
		if req.AuthEnabled != nil {
			authEnabled = *req.AuthEnabled
		}
		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('authEnabled', ?)",
			map[bool]string{true: "true", false: "false"}[authEnabled],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
			return
		}

		// Generate avatar if not provided
		avatar := req.Avatar
		if avatar == "" {
			avatar = avatarOptions[time.Now().UnixNano()%int64(len(avatarOptions))]
		}

		// Hash password if provided
		var hashedPassword *string
		if req.Password != "" {
			hashed, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "密码加密失败"})
				return
			}
			hashedPassword = new(string)
			*hashedPassword = string(hashed)
		}

		// Create first user as ADMIN
		userID := generateID()
		_, err = db.Exec(
			"INSERT INTO users (id, nickname, password, avatar, type, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			userID, req.Nickname, hashedPassword, avatar, "HUMAN", "ADMIN", time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建用户失败"})
			return
		}

		// Generate token
		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, userID, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建会话失败"})
			return
		}

		// Set cookie
		c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       userID,
				"nickname": req.Nickname,
				"avatar":   avatar,
				"type":     "HUMAN",
				"role":     "ADMIN",
			},
			"token":           tokenKey,
			"requirePassword": requirePassword,
		})
	}
}

// Login handles user login/registration
func Login(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientIP := c.ClientIP()
		if !checkRateLimit("login:" + clientIP) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}

		var req LoginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式错误"})
			return
		}

		nickname := req.Nickname
		if nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}

		if !checkRateLimit("login:" + nickname) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}

		// Check if user exists by nickname
		var existingUser struct {
			ID       string
			Password string
			Nickname string
			Avatar   string
			UserType string
			Role     string
		}

		err := db.QueryRow(
			"SELECT id, password, nickname, avatar, type, role FROM users WHERE nickname = ?",
			nickname,
		).Scan(&existingUser.ID, &existingUser.Password, &existingUser.Nickname, &existingUser.Avatar, &existingUser.UserType, &existingUser.Role)

		if err == sql.ErrNoRows {
			// User doesn't exist, create new user only if registration is allowed
			// Check if first user
			var userCount int
			err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
				return
			}

			// Check allowRegistration setting (skip if first user)
			if userCount > 0 {
				var allowRegistration string
				err := db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowRegistration)
				if err == nil && allowRegistration == "false" {
					c.JSON(http.StatusForbidden, gin.H{"error": "注册已关闭，请联系管理员添加用户"})
					return
				}
			}

			isFirstUser := userCount == 0

			avatar := req.Avatar

			// Set user type and role
			userType := req.Type
			if userType == "" {
				userType = "HUMAN"
			}
			role := "MEMBER"
			if isFirstUser {
				role = "ADMIN"
			}

			// Hash password if provided
			var hashedPassword *string
			if req.Password != "" {
				hashed, err := hashWithSalt(req.Password)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "密码加密失败"})
					return
				}
				hashedPassword = &hashed
			}

			// Create user
			userID := generateID()
			_, err = db.Exec(
				"INSERT INTO users (id, nickname, password, avatar, type, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				userID, nickname, hashedPassword, avatar, userType, role, time.Now(), time.Now(),
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "创建用户失败"})
				return
			}

			LogActivity(db, userID, "USER_CREATE", "USER", userID, nickname, "", c.ClientIP(), getRequestSource(c))

			// Generate token
			tokenKey := generateTokenKey()
			tokenID := generateID()
			_, err = db.Exec(
				"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				tokenID, "default", tokenKey, userID, time.Now(), time.Now(),
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
				return
			}

			// Create default board permissions for all boards
			if isFirstUser {
				rows, err := db.Query("SELECT id FROM boards WHERE deleted = false")
				if err == nil {
					defer rows.Close()
					for rows.Next() {
						var boardID string
						if err := rows.Scan(&boardID); err == nil {
							permID := generateID()
							db.Exec(
								"INSERT INTO board_permissions (id, user_id, board_id, access) VALUES (?, ?, ?, ?)",
								permID, userID, boardID, "ADMIN",
							)
						}
					}
				}
			}

			// Set cookie
			c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

			c.JSON(http.StatusOK, gin.H{
				"user": gin.H{
					"id":       userID,
					"nickname": nickname,
					"avatar":   avatar,
					"type":     userType,
					"role":     role,
				},
				"token": tokenKey,
			})
			return
		} else if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
			return
		}

		// User exists, verify password
		if existingUser.Password != "" && req.Password == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":           "请输入密码",
				"requirePassword": true,
			})
			return
		}

		if existingUser.Password != "" {
			if !verifyWithSalt(req.Password, existingUser.Password) {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "密码错误"})
				return
			}
		}

		// Generate token for existing user
		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, existingUser.ID, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
			return
		}

		// Set cookie
		c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

		LogActivity(db, existingUser.ID, "LOGIN", "USER", existingUser.ID, existingUser.Nickname, "", c.ClientIP(), getRequestSource(c))

		var requirePassword bool = false
		var requirePasswordVal string
		if err := db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePasswordVal); err == nil {
			requirePassword = requirePasswordVal == "true"
		}

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       existingUser.ID,
				"nickname": existingUser.Nickname,
				"avatar":   existingUser.Avatar,
				"type":     existingUser.UserType,
				"role":     existingUser.Role,
			},
			"token":           tokenKey,
			"requirePassword": requirePassword,
		})
	}
}

// GetAvatars returns preset avatar options
func GetAvatars() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"avatars": avatarOptions})
	}
}

// GetMe returns current user info
func GetMe(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Get app config for requirePassword setting
		var requirePasswordVal string
		var isRequirePassword bool = false
		if err := db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePasswordVal); err == nil {
			isRequirePassword = requirePasswordVal == "true"
		}

		// Check if any users exist
		var userCount int
		err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
		if err != nil || userCount == 0 {
			c.JSON(http.StatusOK, gin.H{
				"user":              nil,
				"needsSetup":        true,
				"allowRegistration": true,
				"requirePassword":   isRequirePassword,
			})
			return
		}

		tokenKey, err := c.Cookie("kanban-token")
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"user":            nil,
				"needsSetup":      false,
				"requirePassword": isRequirePassword,
			})
			return
		}

		var user models.User
		var token models.Token
		err = db.QueryRow(
			"SELECT t.id, t.expires_at, u.id, u.nickname, u.avatar, u.type, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
			tokenKey,
		).Scan(&token.ID, &token.ExpiresAt, &user.ID, &user.Nickname, &user.Avatar, &user.Type, &user.Role)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"user":            nil,
				"needsSetup":      false,
				"requirePassword": isRequirePassword,
			})
			return
		}

		// Check token expiration
		if token.ExpiresAt != nil && token.ExpiresAt.Before(time.Now()) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"user":            nil,
				"error":           "Token 已过期",
				"needsSetup":      false,
				"requirePassword": isRequirePassword,
			})
			return
		}

		// Get permissions
		rows, err := db.Query(
			"SELECT bp.board_id, b.name, bp.access FROM board_permissions bp JOIN boards b ON bp.board_id = b.id WHERE bp.user_id = ?",
			user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取用户信息失败"})
			return
		}
		defer rows.Close()

		var permissions []gin.H
		for rows.Next() {
			var boardID, boardName, access string
			if err := rows.Scan(&boardID, &boardName, &access); err == nil {
				permissions = append(permissions, gin.H{
					"boardId":   boardID,
					"boardName": boardName,
					"access":    access,
				})
			}
		}

		// Get app config
		var allowRegistration bool = true
		var requirePassword bool = false
		var authEnabled bool = true
		db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowRegistration)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePassword)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'authEnabled'").Scan(&authEnabled)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       user.ID,
				"nickname": user.Nickname,
				"avatar":   user.Avatar,
				"type":     user.Type,
				"role":     user.Role,
			},
			"permissions":       permissions,
			"needsSetup":        false,
			"allowRegistration": allowRegistration,
			"requirePassword":   requirePassword,
			"authEnabled":       authEnabled,
		})
	}
}

// GetTokens returns user's tokens
func GetTokens(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		rows, err := db.Query(
			"SELECT id, name, key, user_agent, expires_at, created_at, updated_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
			user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取失败"})
			return
		}
		defer rows.Close()

		var tokens []gin.H
		for rows.Next() {
			var t models.Token
			if err := rows.Scan(&t.ID, &t.Name, &t.Key, &t.UserAgent, &t.ExpiresAt, &t.CreatedAt, &t.UpdatedAt); err == nil {
				// Mask key
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

// CreateTokenRequest represents token creation request
type CreateTokenRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

// CreateToken creates a new token
func CreateToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		if !checkRateLimit("token:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}

		var req CreateTokenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		name := req.Name
		if name == "" {
			name = "新 Token"
		}

		_, err := db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, user_agent, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			tokenID, name, tokenKey, user.ID, c.Request.UserAgent(), req.ExpiresAt, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建失败"})
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

// UpdateToken updates a token name
func UpdateToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		tokenID := c.Query("id")
		if tokenID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token ID 必填"})
			return
		}

		var req struct {
			Name string `json:"name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		// Verify token belongs to user
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = ? AND user_id = ?", tokenID, user.ID).Scan(&count)
		if err != nil || count == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token 不存在"})
			return
		}

		_, err = db.Exec("UPDATE tokens SET name = ?, updated_at = datetime('now') WHERE id = ?", req.Name, tokenID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// DeleteToken deletes a token
func DeleteToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		tokenID := c.Query("id")
		if tokenID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token ID 必填"})
			return
		}

		// Verify token belongs to user
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = ? AND user_id = ?", tokenID, user.ID).Scan(&count)
		if err != nil || count == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token 不存在"})
			return
		}

		_, err = db.Exec("DELETE FROM tokens WHERE id = ?", tokenID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// GetUsers returns all users (ADMIN only)
func GetUsers(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以查看"})
			return
		}

		rows, err := db.Query(`
			SELECT u.id, u.nickname, u.avatar, u.type, u.role, u.enabled, u.created_at,
				(SELECT COUNT(*) FROM tokens WHERE user_id = u.id) as token_count,
				(SELECT COUNT(*) FROM comments WHERE user_id = u.id) as comment_count
			FROM users u
			ORDER BY u.created_at DESC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取失败"})
			return
		}
		defer rows.Close()

		var users []gin.H
		for rows.Next() {
			var u models.User
			var tokenCount, commentCount int
			if err := rows.Scan(&u.ID, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &tokenCount, &commentCount); err == nil {
				// Get permissions for user
				permRows, _ := db.Query(
					"SELECT bp.board_id, b.name, bp.access FROM board_permissions bp JOIN boards b ON bp.board_id = b.id WHERE bp.user_id = ?",
					u.ID,
				)
				var permissions []gin.H
				if permRows != nil {
					for permRows.Next() {
						var boardID, boardName, access string
						if err := permRows.Scan(&boardID, &boardName, &access); err == nil {
							permissions = append(permissions, gin.H{
								"boardId":   boardID,
								"boardName": boardName,
								"access":    access,
							})
						}
					}
					permRows.Close()
				}

				users = append(users, gin.H{
					"id":           u.ID,
					"nickname":     u.Nickname,
					"avatar":       u.Avatar,
					"type":         u.Type,
					"role":         u.Role,
					"enabled":      u.Enabled,
					"tokenCount":   tokenCount,
					"commentCount": commentCount,
					"permissions":  permissions,
					"createdAt":    u.CreatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"users": users})
	}
}

// UpdateUserRequest represents user update request
type UpdateUserRequest struct {
	TargetUserID string  `json:"targetUserId"`
	Nickname     string  `json:"nickname"`
	Avatar       *string `json:"avatar"`
	Role         string  `json:"role"`
	Type         string  `json:"type"`
}

// UpdateUser updates user profile or role (ADMIN only for role/type)
func UpdateUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		currentUser := getCurrentUser(c, db)
		if currentUser == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		var req UpdateUserRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		if req.TargetUserID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户 ID 必填"})
			return
		}

		isSelfUpdate := currentUser.ID == req.TargetUserID
		isAdmin := currentUser.Role == "ADMIN"

		if !isSelfUpdate && !isAdmin {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以操作其他用户"})
			return
		}

		var oldUser struct {
			Nickname string
			Avatar   string
			Role     string
			Type     string
		}
		db.QueryRow("SELECT nickname, avatar, role, type FROM users WHERE id = ?", req.TargetUserID).Scan(&oldUser.Nickname, &oldUser.Avatar, &oldUser.Role, &oldUser.Type)

		var changes []string

		if req.Nickname != "" && req.Nickname != oldUser.Nickname {
			changes = append(changes, fmt.Sprintf("昵称: '%s' → '%s'", oldUser.Nickname, req.Nickname))
		}
		if req.Avatar != nil && *req.Avatar != oldUser.Avatar {
			changes = append(changes, fmt.Sprintf("头像: '%s' → '%s'", oldUser.Avatar, *req.Avatar))
		}

		if !isSelfUpdate || isAdmin {
			if req.Role != "" && req.Role != oldUser.Role {
				if req.Role != "ADMIN" && req.Role != "MEMBER" && req.Role != "VIEWER" {
					c.JSON(http.StatusBadRequest, gin.H{"error": "无效的角色，有效值为：ADMIN, MEMBER, VIEWER"})
					return
				}
				changes = append(changes, fmt.Sprintf("角色: '%s' → '%s'", oldUser.Role, req.Role))
			}
			if req.Type != "" && req.Type != oldUser.Type {
				changes = append(changes, fmt.Sprintf("类型: '%s' → '%s'", oldUser.Type, req.Type))
			}
		}

		updates := []interface{}{time.Now()}
		query := "UPDATE users SET updated_at = ?"

		if req.Nickname != "" {
			query += ", nickname = ?"
			updates = append(updates, req.Nickname)
		}
		if req.Avatar != nil {
			query += ", avatar = ?"
			updates = append(updates, *req.Avatar)
		}

		if !isSelfUpdate || isAdmin {
			if req.Role != "" {
				if req.Role != "ADMIN" && req.Role != "MEMBER" && req.Role != "VIEWER" {
					c.JSON(http.StatusBadRequest, gin.H{"error": "无效的角色，有效值为：ADMIN, MEMBER, VIEWER"})
					return
				}
				query += ", role = ?"
				updates = append(updates, req.Role)
			}
			if req.Type != "" {
				query += ", type = ?"
				updates = append(updates, req.Type)
			}
		}

		query += " WHERE id = ?"
		updates = append(updates, req.TargetUserID)

		_, err := db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		var updatedUser models.User
		err = db.QueryRow("SELECT id, nickname, avatar, role, type FROM users WHERE id = ?", req.TargetUserID).Scan(
			&updatedUser.ID, &updatedUser.Nickname, &updatedUser.Avatar, &updatedUser.Role, &updatedUser.Type,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取更新后的用户信息失败"})
			return
		}

		details := ""
		if len(changes) > 0 {
			details = strings.Join(changes, ", ")
		}

		LogActivity(db, currentUser.ID, "USER_UPDATE", "USER", req.TargetUserID, updatedUser.Nickname, details, c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       updatedUser.ID,
				"nickname": updatedUser.Nickname,
				"avatar":   updatedUser.Avatar,
				"role":     updatedUser.Role,
				"type":     updatedUser.Type,
			},
		})
	}
}

// GetPermissions returns user's board permissions
func GetPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		targetUserID := user.ID
		requestedUserID := c.Query("userId")

		if requestedUserID != "" && user.Role == "ADMIN" {
			targetUserID = requestedUserID
		} else if requestedUserID != "" && user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以查看其他用户的权限"})
			return
		}

		rows, err := db.Query(`
			SELECT bp.id, bp.board_id, b.name, bp.access
			FROM board_permissions bp
			JOIN boards b ON bp.board_id = b.id
			WHERE bp.user_id = ?
		`, targetUserID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取失败"})
			return
		}
		defer rows.Close()

		var permissions []gin.H
		for rows.Next() {
			var id, boardID, boardName, access string
			if err := rows.Scan(&id, &boardID, &boardName, &access); err == nil {
				permissions = append(permissions, gin.H{
					"id":        id,
					"boardId":   boardID,
					"boardName": boardName,
					"access":    access,
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"permissions": permissions})
	}
}

// SetPermissionRequest represents permission set request
type SetPermissionRequest struct {
	UserID  string `json:"userId"`
	BoardID string `json:"boardId"`
	Access  string `json:"access"`
}

// SetPermission sets board permission for a user (ADMIN only)
func SetPermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以分配权限"})
			return
		}

		var req SetPermissionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数不完整"})
			return
		}

		if req.UserID == "" || req.BoardID == "" || req.Access == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数不完整"})
			return
		}

		// Validate access
		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}
		if !validAccesses[req.Access] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的权限值"})
			return
		}

		// Upsert permission
		permID := generateID()
		_, err := db.Exec(`
			INSERT INTO board_permissions (id, user_id, board_id, access)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, board_id) DO UPDATE SET access = excluded.access
		`, permID, req.UserID, req.BoardID, req.Access)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "设置失败"})
			return
		}

		// Get board name
		var boardName string
		db.QueryRow("SELECT name FROM boards WHERE id = ?", req.BoardID).Scan(&boardName)

		c.JSON(http.StatusOK, gin.H{
			"permission": gin.H{
				"id":        permID,
				"userId":    req.UserID,
				"boardId":   req.BoardID,
				"boardName": boardName,
				"access":    req.Access,
			},
		})
	}
}

// DeletePermission deletes a board permission (ADMIN only)
func DeletePermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以删除权限"})
			return
		}

		permID := c.Query("id")
		if permID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "权限 ID 必填"})
			return
		}

		_, err := db.Exec("DELETE FROM board_permissions WHERE id = ?", permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// UpdateAppConfigRequest represents app config update request
type UpdateAppConfigRequest struct {
	AllowRegistration *bool `json:"allowRegistration"`
	RequirePassword   *bool `json:"requirePassword"`
	AuthEnabled       *bool `json:"authEnabled"`
}

// GetAppConfig returns current app config (public)
func GetAppConfig(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var allowRegistration bool = true
		var requirePassword bool = false
		var authEnabled bool = true
		db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowRegistration)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePassword)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'authEnabled'").Scan(&authEnabled)

		c.JSON(http.StatusOK, gin.H{
			"allowRegistration": allowRegistration,
			"requirePassword":   requirePassword,
			"authEnabled":       authEnabled,
		})
	}
}

// UpdateAppConfig updates app config (ADMIN only)
func UpdateAppConfig(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以修改系统配置"})
			return
		}

		var req UpdateAppConfigRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		if req.AllowRegistration != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', ?)",
				map[bool]string{true: "true", false: "false"}[*req.AllowRegistration],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
				return
			}
		}

		if req.RequirePassword != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('requirePassword', ?)",
				map[bool]string{true: "true", false: "false"}[*req.RequirePassword],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
				return
			}
		}

		if req.AuthEnabled != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('authEnabled', ?)",
				map[bool]string{true: "true", false: "false"}[*req.AuthEnabled],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "保存配置失败"})
				return
			}
		}

		LogActivity(db, user.ID, "APP_CONFIG_UPDATE", "SYSTEM", "", "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// Helper functions
func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateTokenKey() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
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

	tokenCacheMux.Lock()
	if cached, ok := tokenCache[tokenKey]; ok && time.Now().Before(cached.expiresAt) {
		user := cached.user
		tokenCacheMux.Unlock()
		return user
	}
	tokenCacheMux.Unlock()

	var user models.User
	var token models.Token
	err := db.QueryRow(
		"SELECT t.expires_at, u.id, u.nickname, u.avatar, u.type, u.role, u.enabled FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
		tokenKey,
	).Scan(&token.ExpiresAt, &user.ID, &user.Nickname, &user.Avatar, &user.Type, &user.Role, &user.Enabled)
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

	tokenCacheMux.Lock()
	tokenCache[tokenKey] = &cachedUser{
		user:      &user,
		expiresAt: time.Now().Add(tokenCacheDuration),
	}
	tokenCacheMux.Unlock()

	return &user
}

// RequireAuth middleware requires authentication (unless auth is disabled via app_config)
func RequireAuth(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if isAuthEnabled(db) {
			user := getCurrentUser(c, db)
			if user == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录或登录已过期"})
				c.Abort()
				return
			}
			c.Set("user", user)
		}
		c.Next()
	}
}

// isAuthEnabled checks if authentication is enabled in app_config
func isAuthEnabled(db *sql.DB) bool {
	var authEnabled string
	err := db.QueryRow("SELECT value FROM app_config WHERE key = 'authEnabled'").Scan(&authEnabled)
	if err != nil {
		return true
	}
	return authEnabled != "false"
}

// OptionalAuth middleware sets user if authenticated but doesn't require it
func OptionalAuth(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if user := getCurrentUser(c, db); user != nil {
			c.Set("user", user)
		}
		c.Next()
	}
}

// getUserFromContext retrieves authenticated user from context
func getUserFromContext(c *gin.Context) *models.User {
	if user, exists := c.Get("user"); exists {
		if u, ok := user.(*models.User); ok {
			return u
		}
	}
	return getCurrentUser(c, nil)
}

// checkBoardAccess checks if user has required access level on a board
func checkBoardAccess(db *sql.DB, userID, boardID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || boardID == "" {
		return false
	}
	var access string
	err := db.QueryRow(
		"SELECT access FROM board_permissions WHERE user_id = ? AND board_id = ?",
		userID, boardID,
	).Scan(&access)
	if err != nil {
		return false
	}
	accessLevel := map[string]int{"READ": 1, "WRITE": 2, "ADMIN": 3}
	requiredLevel := accessLevel[requiredAccess]
	userLevel := accessLevel[access]
	if userLevel >= requiredLevel {
		return true
	}
	return false
}

// getBoardIDForTask gets the board ID that a task belongs to
func getBoardIDForTask(db *sql.DB, taskID string) (string, error) {
	var boardID string
	err := db.QueryRow(`
		SELECT c.board_id 
		FROM tasks t 
		JOIN columns c ON t.column_id = c.id 
		WHERE t.id = ?
	`, taskID).Scan(&boardID)
	return boardID, err
}

// getBoardIDForColumn gets the board ID that a column belongs to
func getBoardIDForColumn(db *sql.DB, columnID string) (string, error) {
	var boardID string
	err := db.QueryRow(
		"SELECT board_id FROM columns WHERE id = ?",
		columnID,
	).Scan(&boardID)
	return boardID, err
}

type Activity struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	Action      string    `json:"action"`
	TargetType  string    `json:"targetType"`
	TargetID    string    `json:"targetId,omitempty"`
	TargetTitle string    `json:"targetTitle,omitempty"`
	Details     string    `json:"details,omitempty"`
	IPAddress   string    `json:"ipAddress,omitempty"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"createdAt"`
}

func LogActivity(db *sql.DB, userID, action, targetType, targetID, targetTitle, details, ipAddress, source string) {
	id := generateID()
	createdAt := time.Now()
	db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, userID, action, targetType, targetID, targetTitle, details, ipAddress, source, createdAt,
	)
	db.Exec("UPDATE users SET last_active_at = datetime('now') WHERE id = ?", userID)
	go BroadcastActivity(Activity{
		ID:          id,
		UserID:      userID,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		TargetTitle: targetTitle,
		Details:     details,
		IPAddress:   ipAddress,
		Source:      source,
		CreatedAt:   createdAt,
	})

	if targetType == "TASK" {
		boardID, err := getBoardIDForTask(db, targetID)
		if err == nil && boardID != "" {
			notifyAction := action
			if action == "CREATE_TASK" {
				notifyAction = "create"
			} else if action == "UPDATE_TASK" {
				notifyAction = "update"
			} else if action == "COMPLETE_TASK" {
				notifyAction = "update_status"
			} else if action == "ADD_COMMENT" {
				notifyAction = "new_comment"
			}
			go BroadcastTaskNotification(boardID, targetID, notifyAction)
		}
	}
}

func getRequestSource(c *gin.Context) string {
	if user, exists := c.Get("user"); exists {
		if u, ok := user.(*models.User); ok && u.Type == "AGENT" {
			return "mcp"
		}
	}
	if c.GetHeader("X-MCP-Request") == "true" {
		return "mcp"
	}
	return "web"
}

func GetActivities(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		filterUserID := c.Query("userId")
		filterAction := c.Query("action")
		filterStartTime := c.Query("startTime")
		filterEndTime := c.Query("endTime")
		filterAgentOnly := c.Query("agentOnly")

		baseQuery := "SELECT a.id, a.user_id, a.action, a.target_type, a.target_id, a.target_title, a.details, a.ip_address, a.source, a.created_at FROM activities a"
		whereClause := ""
		args := []interface{}{}

		if filterAgentOnly == "true" {
			baseQuery += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
		}

		if user.Role != "ADMIN" {
			filterUserID = user.ID
		}

		if filterUserID != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.user_id = ?"
			args = append(args, filterUserID)
		}

		if filterAction != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.action = ?"
			args = append(args, filterAction)
		}

		if filterStartTime != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.created_at >= ?"
			args = append(args, filterStartTime)
		}

		if filterEndTime != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.created_at <= ?"
			args = append(args, filterEndTime)
		}

		if whereClause != "" {
			baseQuery += " WHERE " + whereClause
		}

		limit := 50
		offset := 0
		if l := c.Query("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}
		if o := c.Query("offset"); o != "" {
			if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		countQuery := "SELECT COUNT(*) FROM activities a"
		if filterAgentOnly == "true" {
			countQuery += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
		}
		if whereClause != "" {
			countQuery += " WHERE " + whereClause
		}
		var total int
		if len(args) > 0 {
			db.QueryRow(countQuery, args...).Scan(&total)
		} else {
			db.QueryRow(countQuery).Scan(&total)
		}

		baseQuery += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
		queryArgs := append(args, limit, offset)

		var rows *sql.Rows
		var err error

		if len(queryArgs) > 0 {
			rows, err = db.Query(baseQuery, queryArgs...)
		} else {
			rows, err = db.Query(baseQuery)
		}

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取活动记录失败"})
			return
		}
		defer rows.Close()

		var activities []Activity
		for rows.Next() {
			var a Activity
			if err := rows.Scan(&a.ID, &a.UserID, &a.Action, &a.TargetType, &a.TargetID, &a.TargetTitle, &a.Details, &a.IPAddress, &a.Source, &a.CreatedAt); err == nil {
				activities = append(activities, a)
			}
		}

		hasMore := offset+len(activities) < total
		c.JSON(http.StatusOK, gin.H{"activities": activities, "hasMore": hasMore, "total": total})
	}
}

// GetAgents returns all agent users
func GetAgents(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		rows, err := db.Query(`
			SELECT u.id, u.nickname, u.avatar, u.type, u.role, u.enabled, u.created_at, u.updated_at, u.last_active_at,
				(SELECT COUNT(*) FROM tokens WHERE user_id = u.id) as token_count
			FROM users u
			WHERE u.type = 'AGENT'
			ORDER BY u.created_at DESC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取失败"})
			return
		}
		defer rows.Close()

		var agents []gin.H
		for rows.Next() {
			var u models.User
			var tokenCount int
			var lastActiveAt sql.NullTime
			if err := rows.Scan(&u.ID, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt, &lastActiveAt, &tokenCount); err == nil {
				agent := gin.H{
					"id":         u.ID,
					"nickname":   u.Nickname,
					"avatar":     u.Avatar,
					"type":       u.Type,
					"role":       u.Role,
					"enabled":    u.Enabled,
					"createdAt":  u.CreatedAt,
					"updatedAt":  u.UpdatedAt,
					"tokenCount": tokenCount,
				}
				if lastActiveAt.Valid {
					agent["lastActiveAt"] = lastActiveAt.Time
				}
				agents = append(agents, agent)
			}
		}

		c.JSON(http.StatusOK, gin.H{"agents": agents})
	}
}

// CreateAgentRequest represents agent creation request
type CreateAgentRequest struct {
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Role     string `json:"role"`
}

// CreateAgent creates a new agent user (ADMIN only)
func CreateAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以创建 Agent"})
			return
		}

		var req CreateAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		if req.Nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}

		avatar := req.Avatar

		agentID := generateID()
		now := time.Now()

		role := req.Role
		if role == "" {
			role = "ADMIN"
		}
		if role != "ADMIN" && role != "MEMBER" && role != "VIEWER" {
			role = "ADMIN"
		}

		// Create agent user
		_, err := db.Exec(
			"INSERT INTO users (id, nickname, avatar, type, role, created_at, updated_at, last_active_at) VALUES (?, ?, ?, 'AGENT', ?, ?, ?, ?)",
			agentID, req.Nickname, avatar, role, now, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建失败"})
			return
		}

		// Generate default token for agent
		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, agentID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建失败"})
			return
		}

		// Grant agent WRITE permission on all boards by default (batch insert)
		rows, err := db.Query("SELECT id FROM boards WHERE deleted = false")
		if err == nil {
			defer rows.Close()
			var boardIDs []string
			for rows.Next() {
				var boardID string
				if err := rows.Scan(&boardID); err == nil {
					boardIDs = append(boardIDs, boardID)
				}
			}
			if len(boardIDs) > 0 {
				args := make([]interface{}, 0, len(boardIDs)*4)
				placeholders := make([]string, len(boardIDs))
				for i, boardID := range boardIDs {
					permID := generateID()
					placeholders[i] = "(?, ?, ?, ?)"
					args = append(args, permID, agentID, boardID, "ADMIN")
				}
				query := "INSERT INTO board_permissions (id, user_id, board_id, access) VALUES " + strings.Join(placeholders, ", ")
				db.Exec(query, args...)
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"agent": gin.H{
				"id":        agentID,
				"nickname":  req.Nickname,
				"avatar":    avatar,
				"type":      "AGENT",
				"token":     tokenKey,
				"createdAt": now,
			},
		})
	}
}

// DeleteAgent deletes an agent user (ADMIN only)
func DeleteAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以删除 Agent"})
			return
		}

		agentID := c.Query("id")
		if agentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Agent ID 必填"})
			return
		}

		// Verify it's an agent
		var userType string
		err := db.QueryRow("SELECT type FROM users WHERE id = ?", agentID).Scan(&userType)
		if err != nil || userType != "AGENT" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
			return
		}

		_, err = db.Exec("DELETE FROM users WHERE id = ?", agentID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// ResetAgentToken regenerates token for an agent (ADMIN only)
func ResetAgentToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以重置 Token"})
			return
		}

		agentID := c.Query("id")
		if agentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Agent ID 必填"})
			return
		}

		// Verify it's an agent
		var userType string
		err := db.QueryRow("SELECT type FROM users WHERE id = ?", agentID).Scan(&userType)
		if err != nil || userType != "AGENT" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
			return
		}

		// Generate new token
		tokenKey := generateTokenKey()
		tokenID := generateID()
		now := time.Now()

		// Delete old tokens
		db.Exec("DELETE FROM tokens WHERE user_id = ?", agentID)

		// Create new token
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, agentID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "重置失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token": tokenKey,
		})
	}
}

// SetUserEnabledRequest represents enable/disable user request
type SetUserEnabledRequest struct {
	UserID  string `json:"userId"`
	Enabled bool   `json:"enabled"`
}

// SetUserEnabled enables or disables a user (ADMIN only)
func SetUserEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		currentUser := getCurrentUser(c, db)
		if currentUser == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if currentUser.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以启用/禁用用户"})
			return
		}

		var req SetUserEnabledRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误"})
			return
		}

		if req.UserID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户 ID 必填"})
			return
		}

		// Cannot disable yourself
		if req.UserID == currentUser.ID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无法启用/禁用自己"})
			return
		}

		// Verify user exists
		var exists bool
		db.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?)", req.UserID).Scan(&exists)
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在"})
			return
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?",
			req.Enabled, now, req.UserID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "操作失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func checkColumnAccess(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || columnID == "" {
		return false
	}
	var access string
	err := db.QueryRow(
		"SELECT access FROM column_permissions WHERE user_id = ? AND column_id = ?",
		userID, columnID,
	).Scan(&access)
	if err != nil {
		return false
	}
	accessLevel := map[string]int{"READ": 1, "WRITE": 2, "ADMIN": 3}
	requiredLevel := accessLevel[requiredAccess]
	userLevel := accessLevel[access]
	return userLevel >= requiredLevel
}

func checkColumnAccessWithBoardFallback(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if checkColumnAccess(db, userID, columnID, requiredAccess, userRole) {
		return true
	}
	boardID, err := getBoardIDForColumn(db, columnID)
	if err != nil {
		return false
	}
	return checkBoardAccess(db, userID, boardID, requiredAccess, userRole)
}

type SetColumnPermissionRequest struct {
	UserID   string `json:"userId"`
	ColumnID string `json:"columnId"`
	Access   string `json:"access"`
}

func GetColumnPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		targetUserID := user.ID
		requestedUserID := c.Query("userId")
		requestedColumnID := c.Query("columnId")

		if requestedUserID != "" && user.Role == "ADMIN" {
			targetUserID = requestedUserID
		} else if requestedUserID != "" && user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以查看其他用户的权限"})
			return
		}

		var rows *sql.Rows
		var err error

		if requestedColumnID != "" && user.Role == "ADMIN" {
			rows, err = db.Query(`
				SELECT cp.id, cp.column_id, col.name, cp.access
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				WHERE cp.column_id = ?
			`, requestedColumnID)
		} else {
			rows, err = db.Query(`
				SELECT cp.id, cp.column_id, col.name, cp.access
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				WHERE cp.user_id = ?
			`, targetUserID)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取失败"})
			return
		}
		defer rows.Close()

		var permissions []gin.H
		for rows.Next() {
			var id, columnID, columnName, access string
			if err := rows.Scan(&id, &columnID, &columnName, &access); err == nil {
				permissions = append(permissions, gin.H{
					"id":         id,
					"columnId":   columnID,
					"columnName": columnName,
					"access":     access,
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"permissions": permissions})
	}
}

func SetColumnPermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以分配权限"})
			return
		}

		var req SetColumnPermissionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数不完整"})
			return
		}

		if req.UserID == "" || req.ColumnID == "" || req.Access == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数不完整"})
			return
		}

		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}
		if !validAccesses[req.Access] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的权限值"})
			return
		}

		permID := generateID()
		_, err := db.Exec(`
			INSERT INTO column_permissions (id, user_id, column_id, access)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, column_id) DO UPDATE SET access = excluded.access
		`, permID, req.UserID, req.ColumnID, req.Access)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "设置失败"})
			return
		}

		var columnName string
		db.QueryRow("SELECT name FROM columns WHERE id = ?", req.ColumnID).Scan(&columnName)

		c.JSON(http.StatusOK, gin.H{
			"permission": gin.H{
				"id":         permID,
				"userId":     req.UserID,
				"columnId":   req.ColumnID,
				"columnName": columnName,
				"access":     req.Access,
			},
		})
	}
}

func DeleteColumnPermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以删除权限"})
			return
		}

		permID := c.Query("id")
		if permID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "权限 ID 必填"})
			return
		}

		_, err := db.Exec("DELETE FROM column_permissions WHERE id = ?", permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
