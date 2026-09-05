package handlers

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

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

		if requestedUserID != "" && isAdmin(user) {
			targetUserID = requestedUserID
		} else if requestedUserID != "" && !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can view other users' permissions"})
			return
		}

		var rows *sql.Rows
		var err error

		if requestedColumnID != "" && isAdmin(user) {
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
		if !isAdmin(user) {
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
		// Portable upsert: REPLACE INTO works on both MySQL and SQLite
		// (ON CONFLICT…DO UPDATE is SQLite/PostgreSQL-only and silently
		// fails on MySQL with a syntax error, which is what was
		// returning 500 from /api/v1/auth/permissions/columns). The
		// (user_id, column_id) UNIQUE constraint on the table makes
		// this atomic; no FK references column_permissions.id so the
		// row id rotating on update is safe.
		_, err := db.Exec(`
			REPLACE INTO column_permissions (id, user_id, column_id, access)
			VALUES (?, ?, ?, ?)
		`, permID, req.UserID, req.ColumnID, req.Access)
		if err != nil {
			// Surface the driver error in the response (and the log)
			// so operators can tell FK violations from "table missing"
			// from charset mismatches instead of seeing a flat 500.
			log.Printf("[SetColumnPermission] REPLACE INTO column_permissions failed (user=%s column=%s access=%s): %v", req.UserID, req.ColumnID, req.Access, err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Failed to set column permission: " + err.Error(),
			})
			return
		}

		// After REPLACE the row id is whatever the engine just wrote
		// (the new permID on first insert; potentially a fresh id on
		// update if the engine decided to delete-and-recreate). Read
		// it back so the response always reflects the actual row.
		var actualID string
		if err := db.QueryRow(
			"SELECT id FROM column_permissions WHERE user_id = ? AND column_id = ?",
			req.UserID, req.ColumnID,
		).Scan(&actualID); err == nil {
			permID = actualID
		}

		var columnName string
		db.QueryRow("SELECT name FROM columns WHERE id = ?", req.ColumnID).Scan(&columnName)

		// Invalidate every cached session for the target user so they
		// see the new column access on the next request instead of
		// getting stale permission state from the in-memory cache.
		tokenCache.DeleteByUserID(req.UserID)

		LogActivity(
			db,
			user.ID,
			"PERMISSION_GRANT",
			"COLUMN",
			req.ColumnID,
			columnName,
			"user="+req.UserID+" access="+req.Access,
			c.ClientIP(),
			getRequestSource(c),
		)

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
		if !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can delete permissions"})
			return
		}

		permID := c.Query("id")
		if permID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Permission ID is required"})
			return
		}

		// Capture the affected user / column before the DELETE so we
		// can (a) invalidate the right cache entries and (b) record
		// an activity row that references the column by name.
		var targetUserID, columnID, columnName string
		if err := db.QueryRow(`
			SELECT cp.user_id, cp.column_id, COALESCE(col.name, '')
			FROM column_permissions cp
			LEFT JOIN columns col ON cp.column_id = col.id
			WHERE cp.id = ?
		`, permID).Scan(&targetUserID, &columnID, &columnName); err != nil {
			// Row already gone — treat as success, just skip the
			// side-effects so the operator gets a clean idempotent
			// response instead of a 500 on retry.
			if err == sql.ErrNoRows {
				c.JSON(http.StatusOK, gin.H{"success": true})
				return
			}
			log.Printf("[DeleteColumnPermission] failed to load permission %s: %v", permID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		_, err := db.Exec("DELETE FROM column_permissions WHERE id = ?", permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		tokenCache.DeleteByUserID(targetUserID)

		LogActivity(
			db,
			user.ID,
			"PERMISSION_REVOKE",
			"COLUMN",
			columnID,
			columnName,
			"user="+targetUserID,
			c.ClientIP(),
			getRequestSource(c),
		)

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
