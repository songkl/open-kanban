package handlers

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

type SetPermissionRequest struct {
	UserID  string `json:"userId"`
	BoardID string `json:"boardId"`
	Access  string `json:"access"`
}

func GetPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		targetUserID := user.ID
		requestedUserID := c.Query("userId")
		requestedBoardID := c.Query("boardId")

		if requestedUserID != "" && isAdmin(user) {
			targetUserID = requestedUserID
		} else if requestedUserID != "" && !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can view other users' permissions"})
			return
		}

		// Owners of a board need to see who currently has access
		// to manage grants. Without this branch, an owner who can
		// set/revoke via SetPermission / DeletePermission would
		// still be unable to enumerate the existing rows.
		if requestedBoardID != "" && !isAdmin(user) {
			if !canManageBoardPermissions(db, user, requestedBoardID) {
				c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can list permissions by board"})
				return
			}
		}

		var rows *sql.Rows
		var err error

		if requestedBoardID != "" {
			rows, err = db.Query(`
				SELECT bp.id, bp.board_id, b.name, bp.access, u.id, u.nickname
				FROM board_permissions bp
				JOIN boards b ON bp.board_id = b.id
				JOIN users u ON bp.user_id = u.id
				WHERE bp.board_id = ?
			`, requestedBoardID)
		} else {
			rows, err = db.Query(`
				SELECT bp.id, bp.board_id, b.name, bp.access
				FROM board_permissions bp
				JOIN boards b ON bp.board_id = b.id
				WHERE bp.user_id = ?
			`, targetUserID)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		var permissions []gin.H
		for rows.Next() {
			if requestedBoardID != "" {
				var id, boardID, boardName, access, userID, userNickname string
				if err := rows.Scan(&id, &boardID, &boardName, &access, &userID, &userNickname); err == nil {
					permissions = append(permissions, gin.H{
						"id":           id,
						"boardId":      boardID,
						"boardName":    boardName,
						"access":       access,
						"userId":       userID,
						"userNickname": userNickname,
					})
				}
			} else {
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
		}

		c.JSON(http.StatusOK, gin.H{"permissions": permissions})
	}
}

func SetPermission(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req SetPermissionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		if req.UserID == "" || req.BoardID == "" || req.Access == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}
		if !validAccesses[req.Access] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid permission value"})
			return
		}

		// Authorize: global ADMIN or the board's owner can grant
		// per-board access. Non-owners (even with ADMIN row access
		// granted by another admin) cannot manage permissions — the
		// owner short-circuit in loadBoardAccess gives them ADMIN
		// access for resource checks but SetPermission is a
		// meta-permission that the spec restricts to owner-or-global.
		if !canManageBoardPermissions(db, user, req.BoardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can assign permissions"})
			return
		}

		permID := generateID()
		// Portable upsert: REPLACE INTO works on both MySQL and SQLite
		// (ON CONFLICT…DO UPDATE is SQLite/PostgreSQL-only and silently
		// fails on MySQL with a syntax error). The (user_id, board_id)
		// UNIQUE constraint on the table makes this atomic; no FK
		// references board_permissions.id so the row id rotating on
		// update is safe.
		_, err := db.Exec(`
			REPLACE INTO board_permissions (id, user_id, board_id, access)
			VALUES (?, ?, ?, ?)
		`, permID, req.UserID, req.BoardID, req.Access)
		if err != nil {
			log.Printf("[SetPermission] REPLACE INTO board_permissions failed (user=%s board=%s access=%s): %v", req.UserID, req.BoardID, req.Access, err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Failed to set board permission: " + err.Error(),
			})
			return
		}

		// After REPLACE the row id is whatever the engine just wrote
		// (the new permID on first insert; potentially a fresh id on
		// update if the engine decided to delete-and-recreate). Read
		// it back so the response always reflects the actual row.
		var actualID string
		if err := db.QueryRow(
			"SELECT id FROM board_permissions WHERE user_id = ? AND board_id = ?",
			req.UserID, req.BoardID,
		).Scan(&actualID); err == nil {
			permID = actualID
		}

		var boardName string
		db.QueryRow("SELECT name FROM boards WHERE id = ?", req.BoardID).Scan(&boardName)

		// Invalidate every cached session for the target user so they
		// see the new board access on the next request instead of
		// getting stale permission state from the in-memory cache.
		tokenCache.DeleteByUserID(req.UserID)
		// Drop every cached (user, board) / (user, column) entry
		// for this user + board so the new access takes effect
		// immediately. Resource-wide invalidation covers any other
		// user whose cached board access was stale (defensive, the
		// spec asks for both invalidations).
		permissionCache.InvalidateUser(req.UserID)
		permissionCache.InvalidateResource(req.BoardID)

		LogActivity(
			db,
			user.ID,
			"PERMISSION_GRANT",
			"BOARD",
			req.BoardID,
			boardName,
			"user="+req.UserID+" access="+req.Access,
			c.ClientIP(),
			getRequestSource(c),
		)

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

func DeletePermission(db *sql.DB) gin.HandlerFunc {
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

		// Capture the affected user / board before the DELETE so we
		// can (a) invalidate the right cache entries and (b) record
		// an activity row that references the board by name.
		var targetUserID, boardID, boardName string
		if err := db.QueryRow(`
			SELECT bp.user_id, bp.board_id, COALESCE(b.name, '')
			FROM board_permissions bp
			LEFT JOIN boards b ON bp.board_id = b.id
			WHERE bp.id = ?
		`, permID).Scan(&targetUserID, &boardID, &boardName); err != nil {
			// Row already gone — treat as success, just skip the
			// side-effects so the operator gets a clean idempotent
			// response instead of a 500 on retry.
			if err == sql.ErrNoRows {
				c.JSON(http.StatusOK, gin.H{"success": true})
				return
			}
			log.Printf("[DeletePermission] failed to load permission %s: %v", permID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		// Authorize: global ADMIN or the board's owner can revoke
		// per-board access. Owners get implicit admin rights via
		// the owner_agent_id field recorded when the board was
		// created.
		if !canManageBoardPermissions(db, user, boardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can delete permissions"})
			return
		}

		// Refuse to remove the owner's own permission row — the
		// board must always have an owner that can manage it. The
		// owner cannot demote or revoke themselves.
		var ownerID sql.NullString
		if err := db.QueryRow(
			"SELECT owner_agent_id FROM board_permissions WHERE id = ?", permID,
		).Scan(&ownerID); err == nil && ownerID.Valid && ownerID.String == targetUserID {
			c.JSON(http.StatusForbidden, gin.H{"error": "Cannot revoke the board owner's permission"})
			return
		}

		_, err := db.Exec("DELETE FROM board_permissions WHERE id = ?", permID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		tokenCache.DeleteByUserID(targetUserID)
		// Mirror SetPermission: drop cached access entries for
		// this user and this board so the revoke takes effect
		// immediately on the next request.
		permissionCache.InvalidateUser(targetUserID)
		permissionCache.InvalidateResource(boardID)

		LogActivity(
			db,
			user.ID,
			"PERMISSION_REVOKE",
			"BOARD",
			boardID,
			boardName,
			"user="+targetUserID,
			c.ClientIP(),
			getRequestSource(c),
		)

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

type UpdateAppConfigRequest struct {
	AllowRegistration *bool `json:"allowRegistration"`
	RequirePassword   *bool `json:"requirePassword"`
	AuthEnabled       *bool `json:"authEnabled"`
}

func GetAppConfig(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var allowRegistration bool = true
		var requirePassword bool = false
		var authEnabled bool = true
		db.QueryRow("SELECT value FROM app_config WHERE `key` = 'allowRegistration'").Scan(&allowRegistration)
		db.QueryRow("SELECT value FROM app_config WHERE `key` = 'requirePassword'").Scan(&requirePassword)
		db.QueryRow("SELECT value FROM app_config WHERE `key` = 'authEnabled'").Scan(&authEnabled)

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
		if !isAdmin(user) {
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
				"REPLACE INTO app_config (`key`, value) VALUES ('allowRegistration', ?)",
				map[bool]string{true: "1", false: "0"}[*req.AllowRegistration],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
				return
			}
		}

		if req.RequirePassword != nil {
			_, err := db.Exec(
				"REPLACE INTO app_config (`key`, value) VALUES ('requirePassword', ?)",
				map[bool]string{true: "1", false: "0"}[*req.RequirePassword],
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
				return
			}
		}

		if req.AuthEnabled != nil {
			_, err := db.Exec(
				"REPLACE INTO app_config (`key`, value) VALUES ('authEnabled', ?)",
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
