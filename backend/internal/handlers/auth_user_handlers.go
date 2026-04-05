package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

type UpdateUserRequest struct {
	TargetUserID string  `json:"targetUserId"`
	Nickname     string  `json:"nickname"`
	Avatar       *string `json:"avatar"`
	Role         string  `json:"role"`
	Type         string  `json:"type"`
}

func GetUsers(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can view"})
			return
		}

		rows, err := db.Query(`
			SELECT u.id, u.username, u.nickname, u.avatar, u.type, u.role, u.enabled, u.created_at,
				(SELECT COUNT(*) FROM tokens WHERE user_id = u.id) as token_count,
				(SELECT COUNT(*) FROM comments WHERE user_id = u.id) as comment_count
			FROM users u
			ORDER BY u.created_at DESC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		var users []gin.H
		for rows.Next() {
			var u models.User
			var tokenCount, commentCount int
			if err := rows.Scan(&u.ID, &u.Username, &u.Nickname, &u.Avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &tokenCount, &commentCount); err == nil {
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
					"username":     u.Username,
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

func UpdateUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		currentUser := getCurrentUser(c, db)
		if currentUser == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req UpdateUserRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		if req.TargetUserID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "User ID is required"})
			return
		}

		isSelfUpdate := currentUser.ID == req.TargetUserID
		isAdminUser := isAdmin(currentUser)

		if !isSelfUpdate && !isAdminUser {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can operate on other users"})
			return
		}

		var oldUser struct {
			Username string
			Nickname string
			Avatar   string
			Role     string
			Type     string
		}
		db.QueryRow("SELECT username, nickname, avatar, role, type FROM users WHERE id = ?", req.TargetUserID).Scan(&oldUser.Username, &oldUser.Nickname, &oldUser.Avatar, &oldUser.Role, &oldUser.Type)

		var changes []string

		if req.Nickname != "" && req.Nickname != oldUser.Nickname {
			changes = append(changes, fmt.Sprintf("昵称: '%s' → '%s'", oldUser.Nickname, req.Nickname))
		}
		if req.Avatar != nil && *req.Avatar != oldUser.Avatar {
			changes = append(changes, fmt.Sprintf("头像: '%s' → '%s'", oldUser.Avatar, *req.Avatar))
		}

		if !isSelfUpdate || isAdminUser {
			if req.Role != "" && req.Role != oldUser.Role {
				if req.Role != "ADMIN" && req.Role != "MEMBER" && req.Role != "VIEWER" {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid role, valid values are: ADMIN, MEMBER, VIEWER"})
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

		if !isSelfUpdate || isAdminUser {
			if req.Role != "" {
				if req.Role != "ADMIN" && req.Role != "MEMBER" && req.Role != "VIEWER" {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid role, valid values are: ADMIN, MEMBER, VIEWER"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		var updatedUser models.User
		err = db.QueryRow("SELECT id, username, nickname, avatar, role, type FROM users WHERE id = ?", req.TargetUserID).Scan(
			&updatedUser.ID, &updatedUser.Username, &updatedUser.Nickname, &updatedUser.Avatar, &updatedUser.Role, &updatedUser.Type,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get updated user info"})
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
				"username": updatedUser.Username,
				"nickname": updatedUser.Nickname,
				"avatar":   updatedUser.Avatar,
				"role":     updatedUser.Role,
				"type":     updatedUser.Type,
			},
		})
	}
}

type SetUserEnabledRequest struct {
	UserID  string `json:"userId"`
	Enabled bool   `json:"enabled"`
}

func SetUserEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		currentUser := getCurrentUser(c, db)
		if currentUser == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if currentUser.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can enable/disable users"})
			return
		}

		var req SetUserEnabledRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		if req.UserID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "User ID is required"})
			return
		}

		if req.UserID == currentUser.ID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot enable/disable yourself"})
			return
		}

		var exists bool
		db.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?)", req.UserID).Scan(&exists)
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?",
			req.Enabled, now, req.UserID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Operation failed"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func GetAgents(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
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

type CreateAgentRequest struct {
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Role     string `json:"role"`
}

func CreateAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can create Agent"})
			return
		}

		var req CreateAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		if req.Nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Nickname is required"})
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

		agentID := generateID()
		now := time.Now()

		role := req.Role
		if role == "" {
			role = "ADMIN"
		}
		if role != "ADMIN" && role != "MEMBER" && role != "VIEWER" {
			role = "ADMIN"
		}

		_, err := db.Exec(
			"INSERT INTO users (id, nickname, avatar, type, role, created_at, updated_at, last_active_at) VALUES (?, ?, ?, 'AGENT', ?, ?, ?, ?)",
			agentID, req.Nickname, avatar, role, now, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create"})
			return
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, agentID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create"})
			return
		}

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

func DeleteAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can delete Agent"})
			return
		}

		agentID := c.Query("id")
		if agentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Agent ID is required"})
			return
		}

		var userType string
		err := db.QueryRow("SELECT type FROM users WHERE id = ?", agentID).Scan(&userType)
		if err != nil || userType != "AGENT" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent not found"})
			return
		}

		_, err = db.Exec("DELETE FROM users WHERE id = ?", agentID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func ResetAgentToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can reset Token"})
			return
		}

		agentID := c.Query("id")
		if agentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Agent ID is required"})
			return
		}

		var userType string
		err := db.QueryRow("SELECT type FROM users WHERE id = ?", agentID).Scan(&userType)
		if err != nil || userType != "AGENT" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent not found"})
			return
		}

		tokenKey := generateTokenKey()
		tokenID := generateID()
		now := time.Now()

		db.Exec("DELETE FROM tokens WHERE user_id = ?", agentID)

		_, err = db.Exec(
			"INSERT INTO tokens (id, name, key, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			tokenID, "default", tokenKey, agentID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token": tokenKey,
		})
	}
}
