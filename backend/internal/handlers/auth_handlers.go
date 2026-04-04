package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/models"
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

func Init(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var userCount int
		err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check user"})
			return
		}

		if userCount > 0 {
			c.JSON(http.StatusForbidden, gin.H{"error": "System already initialized, cannot set up again"})
			return
		}

		var req InitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		if req.Username == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Username is required"})
			return
		}

		nickname := req.Nickname
		if nickname == "" {
			nickname = req.Username
		}

		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('allowRegistration', ?)",
			map[bool]string{true: "1", false: "0"}[req.AllowRegistration],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
			return
		}

		requirePassword := req.Password != ""
		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('requirePassword', ?)",
			map[bool]string{true: "1", false: "0"}[requirePassword],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
			return
		}

		authEnabled := true
		if req.AuthEnabled != nil {
			authEnabled = *req.AuthEnabled
		}
		_, err = db.Exec(
			"INSERT OR REPLACE INTO app_config (key, value) VALUES ('authEnabled', ?)",
			map[bool]string{true: "1", false: "0"}[authEnabled],
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
			return
		}

		avatar := req.Avatar
		if avatar == "" {
			if len(avatarOptions) > 0 {
				avatar = avatarOptions[time.Now().UnixNano()%int64(len(avatarOptions))]
			} else {
				avatar = fmt.Sprintf("avatar-%d", time.Now().UnixNano()%1000)
			}
		}

		var hashedPassword *string
		if req.Password != "" {
			hashed, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to encrypt password"})
				return
			}
			hashedPassword = new(string)
			*hashedPassword = string(hashed)
		}

		userID := generateID()
		_, err = db.Exec(
			"INSERT INTO users (id, username, nickname, password, avatar, type, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			userID, req.Username, nickname, hashedPassword, avatar, "HUMAN", "ADMIN", time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
			return
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, userID, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
			return
		}

		c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       userID,
				"username": req.Username,
				"nickname": nickname,
				"avatar":   avatar,
				"type":     "HUMAN",
				"role":     "ADMIN",
			},
			"token":           tokenKey,
			"requirePassword": requirePassword,
		})
	}
}

func Login(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientIP := c.ClientIP()
		if !checkRateLimit("login:" + clientIP) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		var req LoginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
			return
		}

		username := req.Username
		if username == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Username is required"})
			return
		}

		if !checkRateLimit("login:" + username) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		var existingUser struct {
			ID       string
			Password string
			Username string
			Nickname string
			Avatar   string
			UserType string
			Role     string
		}

		err := db.QueryRow(
			"SELECT id, password, username, nickname, avatar, type, role FROM users WHERE username = ?",
			username,
		).Scan(&existingUser.ID, &existingUser.Password, &existingUser.Username, &existingUser.Nickname, &existingUser.Avatar, &existingUser.UserType, &existingUser.Role)

		if err == sql.ErrNoRows {
			var userCount int
			err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Login failed"})
				return
			}

			if userCount > 0 {
				var allowRegistration string
				err := db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowRegistration)
				if err == nil && allowRegistration == "0" {
					c.JSON(http.StatusForbidden, gin.H{"error": "Registration is closed, please contact admin to add user"})
					return
				}
			}

			isFirstUser := userCount == 0

			avatar := req.Avatar

			userType := req.Type
			if userType == "" {
				userType = "HUMAN"
			}
			role := "MEMBER"
			if isFirstUser {
				role = "ADMIN"
			}

			var hashedPassword *string
			if req.Password != "" {
				hashed, err := hashWithSalt(req.Password)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to encrypt password"})
					return
				}
				hashedPassword = &hashed
			}

			userID := generateID()
			_, err = db.Exec(
				"INSERT INTO users (id, username, nickname, password, avatar, type, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				userID, username, username, hashedPassword, avatar, userType, role, time.Now(), time.Now(),
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
				return
			}

			LogActivity(db, userID, "USER_CREATE", "USER", userID, username, "", c.ClientIP(), getRequestSource(c))

			tokenKey := generateTokenKey()
			tokenID := generateID()
			_, err = db.Exec(
				"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				tokenID, "default", tokenKey, userID, time.Now(), time.Now(),
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Login failed"})
				return
			}

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

			c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

			c.JSON(http.StatusOK, gin.H{
				"user": gin.H{
					"id":       userID,
					"username": username,
					"nickname": username,
					"avatar":   avatar,
					"type":     userType,
					"role":     role,
				},
				"token": tokenKey,
			})
			return
		} else if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Login failed"})
			return
		}

		if existingUser.Password != "" && req.Password == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":           "Password is required",
				"requirePassword": true,
			})
			return
		}

		if existingUser.Password != "" {
			if !verifyWithSalt(req.Password, existingUser.Password) {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Incorrect password"})
				return
			}
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, existingUser.ID, time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Login failed"})
			return
		}

		c.SetCookie("kanban-token", tokenKey, 60*60*24*30, "/", "", false, true)

		LogActivity(db, existingUser.ID, "LOGIN", "USER", existingUser.ID, existingUser.Nickname, "", c.ClientIP(), getRequestSource(c))

		var requirePassword bool = false
		var requirePasswordVal string
		if err := db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePasswordVal); err == nil {
			requirePassword = requirePasswordVal == "1"
		}

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       existingUser.ID,
				"username": existingUser.Username,
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

func GetAvatars() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"avatars": avatarOptions})
	}
}

func GetMe(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var requirePasswordVal string
		var isRequirePassword bool = false
		if err := db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePasswordVal); err == nil {
			isRequirePassword = requirePasswordVal == "1"
		}

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

		user := getCurrentUserFromToken(db, tokenKey)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"user":            nil,
				"needsSetup":      false,
				"requirePassword": isRequirePassword,
			})
			return
		}

		rows, err := db.Query(
			"SELECT bp.board_id, b.name, bp.access FROM board_permissions bp JOIN boards b ON bp.board_id = b.id WHERE bp.user_id = ?",
			user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get user info"})
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

		var allowRegistration bool = true
		var requirePassword bool = false
		var authEnabled bool = true
		db.QueryRow("SELECT value FROM app_config WHERE key = 'allowRegistration'").Scan(&allowRegistration)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'requirePassword'").Scan(&requirePassword)
		db.QueryRow("SELECT value FROM app_config WHERE key = 'authEnabled'").Scan(&authEnabled)

		c.JSON(http.StatusOK, gin.H{
			"user": gin.H{
				"id":       user.ID,
				"username": user.Username,
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

func getCurrentUserFromToken(db *sql.DB, tokenKey string) *models.User {
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
		"SELECT t.id, t.expires_at, u.id, u.username, u.nickname, u.avatar, u.type, u.role FROM tokens t JOIN users u ON t.user_id = u.id WHERE t.key = ?",
		tokenKey,
	).Scan(&token.ID, &token.ExpiresAt, &user.ID, &user.Username, &user.Nickname, &user.Avatar, &user.Type, &user.Role)
	if err != nil {
		return nil
	}

	if token.ExpiresAt != nil && token.ExpiresAt.Before(time.Now()) {
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
