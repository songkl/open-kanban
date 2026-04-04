package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

type CreateTokenRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

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

		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM tokens WHERE id = ? AND user_id = ?", tokenID, user.ID).Scan(&count)
		if err != nil || count == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token not found"})
			return
		}

		_, err = db.Exec("DELETE FROM tokens WHERE id = ?", tokenID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
