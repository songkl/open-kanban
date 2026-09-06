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

		if !canManageColumnPermissions(db, user, req.ColumnID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can assign column permissions"})
			return
		}

		boardID, err := getBoardIDForColumn(db, req.ColumnID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load column"})
			return
		}
		owner, err := IsBoardOwner(db, req.UserID, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board owner"})
			return
		}
		if owner {
			c.JSON(http.StatusForbidden, gin.H{"error": "Cannot modify the board owner's column permission"})
			return
		}

		permID := generateID()
		// Portable upsert: REPLACE INTO works on both MySQL and SQLite
		// (ON CONFLICT…DO UPDATE is SQLite/PostgreSQL-only and silently
		// fails on MySQL with a syntax error, which is what was
		// returning 500 from /api/v1/auth/permissions/columns). The
		// (user_id, column_id) UNIQUE constraint on the table makes
		// this atomic; no FK references column_permissions.id so the
		// row id rotating on update is safe. The audit columns are
		// stamped so a re-grant clears any prior revoked_at /
		// revoked_by stamp — granting is a reactivation, not a new add.
		_, err = db.Exec(`
			REPLACE INTO column_permissions (
				id, user_id, column_id, access,
				granted_by_user_id, expires_at, revoked_at, revoked_by_user_id
			)
			VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
		`, permID, req.UserID, req.ColumnID, req.Access, user.ID)
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
		// Drop the cached column-permission entry for this user +
		// column. Resource invalidation also clears any (other
		// user, this column) entries that may be stale.
		permissionCache.InvalidateUser(req.UserID)
		permissionCache.InvalidateResource(req.ColumnID)

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

// DeleteColumnPermission revokes a column permission row. Same
// soft-delete semantics as DeletePermission: the row stays in
// column_permissions but revoked_at / revoked_by_user_id are
// stamped so loadColumnAccess (after we add the filter below)
// treats the grant as inactive. A re-grant through SetColumnPermission
// uses REPLACE INTO and clears the tombstone, so the audit trail is
// retained through a full grant/revoke/re-grant cycle.
func DeleteColumnPermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		permID := c.Query("id")
		if permID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Permission ID is required"})
			return
		}

		// Capture the affected user / column / revocation state
		// before the UPDATE so we can enforce the already-revoked
		// idempotency rule and record an activity row referencing
		// the column by name.
		var (
			targetUserID, columnID, columnName string
			existingRevokedAt                  sql.NullString
		)
		if err := db.QueryRow(`
			SELECT cp.user_id, cp.column_id, COALESCE(col.name, ''),
			       cp.revoked_at
			FROM column_permissions cp
			LEFT JOIN columns col ON cp.column_id = col.id
			WHERE cp.id = ?
		`, permID).Scan(&targetUserID, &columnID, &columnName, &existingRevokedAt); err != nil {
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

		if !canManageColumnPermissions(db, user, columnID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can delete column permissions"})
			return
		}

		boardID, err := getBoardIDForColumn(db, columnID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load column"})
			return
		}
		owner, err := IsBoardOwner(db, targetUserID, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board owner"})
			return
		}
		if owner {
			c.JSON(http.StatusForbidden, gin.H{"error": "Cannot revoke the board owner's column permission"})
			return
		}

		// Already revoked: idempotent no-op so a retry does not
		// stamp a new revoked_at / revoked_by pair and does not
		// log a duplicate PERMISSION_REVOKE row.
		if existingRevokedAt.Valid {
			c.JSON(http.StatusOK, gin.H{"success": true})
			return
		}

		// Soft delete: stamp revoked_at + revoked_by_user_id so
		// loadColumnAccess's revoked_at filter treats the row as
		// inactive. The where clause guarantees we never
		// accidentally re-stamp an already-revoked row.
		res, err := db.Exec(`
			UPDATE column_permissions
			SET revoked_at = CURRENT_TIMESTAMP,
			    revoked_by_user_id = ?
			WHERE id = ?
			  AND revoked_at IS NULL
		`, user.ID, permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			c.JSON(http.StatusOK, gin.H{"success": true})
			return
		}

		tokenCache.DeleteByUserID(targetUserID)
		// Mirror SetColumnPermission: drop cached access entries
		// for this user + column so the revoke takes effect
		// immediately on the next request.
		permissionCache.InvalidateUser(targetUserID)
		permissionCache.InvalidateResource(columnID)

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
