package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"time"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

var avatarOptions = []string{
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Luna",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Max",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Bella",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Charlie",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Sophie",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Jack",
	"https://api.dicebear.com/7.x/avataaars/svg?seed=Olivia",
}

// LoginRequest represents login request body
type LoginRequest struct {
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Type     string `json:"type"`
}

// Login handles user login/registration
func Login(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req LoginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}

		nickname := req.Nickname
		if nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}

		// Check if first user
		var userCount int
		err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
			return
		}
		isFirstUser := userCount == 0

		// Generate avatar if not provided
		avatar := req.Avatar
		if avatar == "" {
			avatar = avatarOptions[time.Now().UnixNano()%int64(len(avatarOptions))]
		}

		// Set user type and role
		userType := req.Type
		if userType == "" {
			userType = "HUMAN"
		}
		role := "USER"
		if isFirstUser {
			role = "ADMIN"
		}

		// Create user
		userID := generateID()
		_, err = db.Exec(
			"INSERT INTO users (id, nickname, avatar, type, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			userID, nickname, avatar, userType, role, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "登录失败"})
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
		tokenKey, err := c.Cookie("kanban-token")
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"user": nil})
			return
		}

		var user models.User
		var token models.Token
		err = db.QueryRow(
			"SELECT t.id, t.expires_at, u.id, u.nickname, u.avatar, u.type, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
			tokenKey,
		).Scan(&token.ID, &token.ExpiresAt, &user.ID, &user.Nickname, &user.Avatar, &user.Type, &user.Role)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"user": nil})
			return
		}

		// Check token expiration
		if token.ExpiresAt != nil && token.ExpiresAt.Before(time.Now()) {
			c.JSON(http.StatusUnauthorized, gin.H{"user": nil, "error": "Token 已过期"})
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

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       user.ID,
				"nickname": user.Nickname,
				"avatar":   user.Avatar,
				"type":     user.Type,
				"role":     user.Role,
			},
			"permissions": permissions,
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
			"SELECT id, name, key, expires_at, created_at, updated_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
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
			if err := rows.Scan(&t.ID, &t.Name, &t.Key, &t.ExpiresAt, &t.CreatedAt, &t.UpdatedAt); err == nil {
				// Mask key
				if len(t.Key) > 12 {
					t.Key = t.Key[:8] + "****" + t.Key[len(t.Key)-4:]
				}
				tokens = append(tokens, gin.H{
					"id":        t.ID,
					"name":      t.Name,
					"key":       t.Key,
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
			"INSERT INTO tokens (id, name, key, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			tokenID, name, tokenKey, user.ID, req.ExpiresAt, time.Now(), time.Now(),
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
			SELECT u.id, u.nickname, u.avatar, u.type, u.role, u.created_at,
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
			if err := rows.Scan(&u.ID, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.CreatedAt, &tokenCount, &commentCount); err == nil {
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
					"id":            u.ID,
					"nickname":      u.Nickname,
					"avatar":        u.Avatar,
					"type":          u.Type,
					"role":          u.Role,
					"tokenCount":    tokenCount,
					"commentCount":  commentCount,
					"permissions":   permissions,
					"createdAt":     u.CreatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, gin.H{"users": users})
	}
}

// UpdateUserRequest represents user update request
type UpdateUserRequest struct {
	TargetUserID string `json:"targetUserId"`
	Role         string `json:"role"`
	Type         string `json:"type"`
}

// UpdateUser updates user role (ADMIN only)
func UpdateUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以操作"})
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

		updates := []interface{}{time.Now()}
		query := "UPDATE users SET updated_at = ?"
		if req.Role != "" {
			query += ", role = ?"
			updates = append(updates, req.Role)
		}
		if req.Type != "" {
			query += ", type = ?"
			updates = append(updates, req.Type)
		}
		query += " WHERE id = ?"
		updates = append(updates, req.TargetUserID)

		_, err := db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		// Get updated user
		var updatedUser models.User
		db.QueryRow("SELECT id, nickname, role, type FROM users WHERE id = ?", req.TargetUserID).Scan(
			&updatedUser.ID, &updatedUser.Nickname, &updatedUser.Role, &updatedUser.Type,
		)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       updatedUser.ID,
				"nickname": updatedUser.Nickname,
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

		rows, err := db.Query(`
			SELECT bp.id, bp.board_id, b.name, bp.access
			FROM board_permissions bp
			JOIN boards b ON bp.board_id = b.id
			WHERE bp.user_id = ?
		`, user.ID)
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
	tokenKey, err := c.Cookie("kanban-token")
	if err != nil {
		return nil
	}

	var user models.User
	var token models.Token
	err = db.QueryRow(
		"SELECT t.expires_at, u.id, u.nickname, u.avatar, u.type, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
		tokenKey,
	).Scan(&token.ExpiresAt, &user.ID, &user.Nickname, &user.Avatar, &user.Type, &user.Role)
	if err != nil {
		return nil
	}

	if token.ExpiresAt != nil && token.ExpiresAt.Before(time.Now()) {
		return nil
	}

	return &user
}
