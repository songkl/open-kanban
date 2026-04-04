package handlers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"open-kanban/internal/models"
)

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
	if rateLimitStoreType == "redis" {
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
				ctx:    ctx,
			}
		} else {
			rateLimitStoreInstance = &memoryRateLimitStore{}
		}
	} else {
		rateLimitStoreInstance = &memoryRateLimitStore{}
	}

	if rateLimitStoreInstance == nil {
		rateLimitStoreInstance = &memoryRateLimitStore{}
	}

	go cleanupRateLimitMap()
	go cleanupGlobalRateLimitMap()
	go cleanupTokenCache()
}
