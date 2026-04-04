package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

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

type SetColumnPermissionRequest struct {
	UserID   string `json:"userId"`
	ColumnID string `json:"columnId"`
	Access   string `json:"access"`
}

func GetColumnPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		targetUserID := user.ID
		requestedUserID := c.Query("userId")
		requestedColumnID := c.Query("columnId")

		if requestedUserID != "" && user.Role == "ADMIN" {
			targetUserID = requestedUserID
		} else if requestedUserID != "" && user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can view other users' permissions"})
			return
		}

		var rows *sql.Rows
		var err error

		if requestedColumnID != "" && user.Role == "ADMIN" {
			rows, err = db.Query(`
				SELECT cp.id, cp.column_id, col.name, cp.access, u.id, u.nickname
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				JOIN users u ON cp.user_id = u.id
				WHERE cp.column_id = ?
			`, requestedColumnID)
		} else {
			rows, err = db.Query(`
				SELECT cp.id, cp.column_id, col.name, cp.access, u.id, u.nickname
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				JOIN users u ON cp.user_id = u.id
				WHERE cp.user_id = ?
			`, targetUserID)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		var permissions []gin.H
		for rows.Next() {
			var id, columnID, columnName, access, userID, userNickname string
			if err := rows.Scan(&id, &columnID, &columnName, &access, &userID, &userNickname); err == nil {
				permissions = append(permissions, gin.H{
					"id":           id,
					"columnId":     columnID,
					"columnName":   columnName,
					"access":       access,
					"userId":       userID,
					"userNickname": userNickname,
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
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can assign permissions"})
			return
		}

		var req SetColumnPermissionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		if req.UserID == "" || req.ColumnID == "" || req.Access == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}
		if !validAccesses[req.Access] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid permission value"})
			return
		}

		permID := generateID()
		_, err := db.Exec(`
			INSERT INTO column_permissions (id, user_id, column_id, access)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, column_id) DO UPDATE SET access = excluded.access
		`, permID, req.UserID, req.ColumnID, req.Access)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set"})
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
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can delete permissions"})
			return
		}

		permID := c.Query("id")
		if permID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Permission ID is required"})
			return
		}

		_, err := db.Exec("DELETE FROM column_permissions WHERE id = ?", permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
