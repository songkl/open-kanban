package handlers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/database"
	"open-kanban/internal/models"
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

var (
	cleanupCtx     context.Context
	cleanupCancel  context.CancelFunc
	cleanupWg      sync.WaitGroup
	cleanupStarted bool
	cleanupOnce    sync.Once
)

type LoginRequest struct {
	Username string `json:"username" validate:"required,max=50"`
	Password string `json:"password" validate:"required,max=100"`
	Avatar   string `json:"avatar" validate:"omitempty,max=500"`
	Type     string `json:"type" validate:"omitempty,max=20"`
}

type InitRequest struct {
	Username          string `json:"username" validate:"required,max=50"`
	Nickname          string `json:"nickname" validate:"omitempty,max=50"`
	Password          string `json:"password" validate:"required,max=100"`
	Avatar            string `json:"avatar" validate:"omitempty,max=500"`
	AllowRegistration bool   `json:"allowRegistration"`
	RequirePassword   bool   `json:"requirePassword"`
	AuthEnabled       *bool  `json:"authEnabled"`
}

type UpdateUserRequest struct {
	TargetUserID string  `json:"targetUserId"`
	Nickname     string  `json:"nickname"`
	Avatar       *string `json:"avatar"`
	Role         string  `json:"role"`
	Type         string  `json:"type"`
}

type SetUserEnabledRequest struct {
	UserID  string `json:"userId"`
	Enabled bool   `json:"enabled"`
}

type CreateAgentRequest struct {
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Role     string `json:"role"`
}

type CreateTokenRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type SetPermissionRequest struct {
	UserID  string `json:"userId"`
	BoardID string `json:"boardId"`
	Access  string `json:"access"`
}

type UpdateAppConfigRequest struct {
	AllowRegistration *bool `json:"allowRegistration"`
	RequirePassword   *bool `json:"requirePassword"`
	AuthEnabled       *bool `json:"authEnabled"`
}

type SetColumnPermissionRequest struct {
	UserID   string `json:"userId"`
	ColumnID string `json:"columnId"`
	Access   string `json:"access"`
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

type rateLimitEntry struct {
	count     int
	resetTime time.Time
}

const (
	maxRateLimitMapSize       = 100000
	maxGlobalRateLimitMapSize = 1000000
)

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

type rateLimitStore interface {
	check(key string, maxRequests int, windowSecs int) bool
}

type memoryRateLimitStore struct{}

func (m *memoryRateLimitStore) check(key string, maxRequests int, windowSecs int) bool {
	rateLimitMux.Lock()
	defer rateLimitMux.Unlock()

	now := time.Now()
	entry, exists := rateLimitMap[key]

	if !exists || now.After(entry.resetTime) {
		if len(rateLimitMap) >= maxRateLimitMapSize {
			for k, e := range rateLimitMap {
				if now.After(e.resetTime) {
					delete(rateLimitMap, k)
					break
				}
			}
			if len(rateLimitMap) >= maxRateLimitMapSize {
				return false
			}
		}
		rateLimitMap[key] = &rateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(windowSecs) * time.Second),
		}
		return true
	}

	if entry.count >= maxRequests {
		return false
	}

	entry.count++
	return true
}

type redisRateLimitStore struct {
	client *redis.Client
}

func (r *redisRateLimitStore) check(key string, maxRequests int, windowSecs int) bool {
	ctx := context.Background()
	rlKey := "ratelimit:" + key

	count, err := r.client.Incr(ctx, rlKey).Result()
	if err != nil {
		return true
	}

	if count == 1 {
		r.client.Expire(ctx, rlKey, time.Duration(windowSecs)*time.Second)
	}

	return count <= int64(maxRequests)
}

var (
	rateLimitStoreInstance rateLimitStore
	redisClient            *redis.Client
)

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

func UpdateAppConfig(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can modify system configuration"})
			return
		}

		var req UpdateAppConfigRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		if req.AllowRegistration != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', ?)",
				map[bool]string{true: "1", false: "0"}[*req.AllowRegistration],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
				return
			}
		}

		if req.RequirePassword != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('requirePassword', ?)",
				map[bool]string{true: "1", false: "0"}[*req.RequirePassword],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
				return
			}
		}

		if req.AuthEnabled != nil {
			_, err := db.Exec(
				"INSERT OR REPLACE INTO app_config (key, value) VALUES ('authEnabled', ?)",
				map[bool]string{true: "1", false: "0"}[*req.AuthEnabled],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
				return
			}
		}

		LogActivity(db, user.ID, "APP_CONFIG_UPDATE", "SYSTEM", "", "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func GetActivities(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get activity records"})
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

func LogActivity(db *sql.DB, userID, action, targetType, targetID, targetTitle, details, ipAddress, source string) {
	id := generateID()
	createdAt := time.Now()
	db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, userID, action, targetType, targetID, targetTitle, details, ipAddress, source, createdAt,
	)
	db.Exec("UPDATE users SET last_active_at = datetime('now') WHERE id = ?", userID)
	go BroadcastActivityExternal(Activity{
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
			go BroadcastTaskNotificationExternal(boardID, targetID, notifyAction)
		}
	}
}

func BroadcastActivityExternal(activity Activity) {
	BroadcastActivity(activity)
}

func BroadcastTaskNotificationExternal(boardID, taskID, action string) {
	BroadcastTaskNotification(boardID, taskID, action)
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

func generateID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

func generateTokenKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if intVal, err := strconv.Atoi(val); err == nil && intVal > 0 {
			return intVal
		}
	}
	return defaultVal
}

func validateInputLength(value string, maxLength int) bool {
	return len(value) <= maxLength
}

func sanitizeString(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\x00", "")
	return value
}

func checkRateLimit(key string) bool {
	return rateLimitStoreInstance.check(key, rateLimitOpts.maxRequests, rateLimitOpts.windowSecs)
}

func checkGlobalRateLimit(key string) bool {
	return rateLimitStoreInstance.check(key, globalRateLimitOpts.maxRequests, globalRateLimitOpts.windowSecs)
}

func GlobalRateLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		key := "global:" + c.ClientIP()

		if !checkGlobalRateLimit(key) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			c.Abort()
			return
		}

		c.Next()
	}
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

	if cached, ok := tokenCache.Load(tokenKey); ok {
		if entry, ok := cached.(*cachedUser); ok && time.Now().Before(entry.expiresAt) && entry.user.Enabled {
			return entry.user
		}
		tokenCache.Delete(tokenKey)
	}

	var user models.User
	var token models.Token
	err := db.QueryRow(
		"SELECT t.expires_at, u.id, u.username, u.nickname, u.avatar, u.type, u.role, u.enabled FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
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

	enforceTokenCacheLimit()
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
	err := db.QueryRow("SELECT value FROM app_config WHERE key = 'authEnabled'").Scan(&authEnabled)
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

func getBoardIDForColumn(db *sql.DB, columnID string) (string, error) {
	var boardID string
	err := db.QueryRow(
		"SELECT board_id FROM columns WHERE id = ?",
		columnID,
	).Scan(&boardID)
	return boardID, err
}

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

func verifyWithSalt(input, hash string) bool {
	salt, err := getSalt()
	if err != nil {
		return false
	}
	combined := salt + input
	err = bcrypt.CompareHashAndPassword([]byte(hash), []byte(combined))
	return err == nil
}

func HashPasswordWithSalt(password string) (string, error) {
	return hashWithSalt(password)
}

func cleanupRateLimitMap(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Minute):
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
}

func cleanupGlobalRateLimitMap(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Minute):
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
}

func ResetRateLimitMapForTest() {
	rateLimitMux.Lock()
	defer rateLimitMux.Unlock()
	rateLimitMap = make(map[string]*rateLimitEntry)
}

func ResetGlobalRateLimitMapForTest() {
	globalRateLimitMux.Lock()
	defer globalRateLimitMux.Unlock()
	globalRateLimitMap = make(map[string]*globalRateLimitEntry)
}

func init() {
	if maxReq := getEnvInt("RATE_LIMIT_MAX_REQUESTS", 5); maxReq > 0 {
		rateLimitOpts.maxRequests = maxReq
	}
	if windowSec := getEnvInt("RATE_LIMIT_WINDOW_SECONDS", 60); windowSec > 0 {
		rateLimitOpts.windowSecs = windowSec
	}
	if globalMaxReq := getEnvInt("GLOBAL_RATE_LIMIT_MAX_REQUESTS", 100); globalMaxReq > 0 {
		globalRateLimitOpts.maxRequests = globalMaxReq
	}
	if globalWindowSec := getEnvInt("GLOBAL_RATE_LIMIT_WINDOW_SECONDS", 60); globalWindowSec > 0 {
		globalRateLimitOpts.windowSecs = globalWindowSec
	}

	rateLimitStoreType := os.Getenv("RATE_LIMIT_STORE")

	if rateLimitStoreType == "memory" {
		rateLimitStoreInstance = &memoryRateLimitStore{}
	} else {
		redisAddr := os.Getenv("REDIS_URL")
		if redisAddr == "" {
			redisAddr = "localhost:6379"
		}
		redisClient = redis.NewClient(&redis.Options{
			Addr: redisAddr,
		})
		ctx := context.Background()
		_, err := redisClient.Ping(ctx).Result()
		if err == nil {
			rateLimitStoreInstance = &redisRateLimitStore{
				client: redisClient,
			}
		} else if rateLimitStoreType == "redis" {
			panic("Redis is configured for rate limiting but is not available: " + err.Error())
		} else {
			rateLimitStoreInstance = &memoryRateLimitStore{}
		}
	}
}

func StartBackgroundCleanup(ctx context.Context) {
	cleanupOnce.Do(func() {
		cleanupCtx, cleanupCancel = context.WithCancel(ctx)
		cleanupWg.Add(3)
		go cleanupRateLimitMap(cleanupCtx, &cleanupWg)
		go cleanupGlobalRateLimitMap(cleanupCtx, &cleanupWg)
		go cleanupTokenCache(cleanupCtx, &cleanupWg)
		cleanupStarted = true
	})
}

func WaitForCleanup(timeout time.Duration) error {
	if !cleanupStarted {
		return nil
	}
	done := make(chan struct{})
	go func() {
		cleanupWg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-time.After(timeout):
		return context.DeadlineExceeded
	}
}

func StopBackgroundCleanup() {
	if cleanupStarted {
		cleanupCancel()
	}
}
