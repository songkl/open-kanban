package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type SetColumnPermissionRequest struct {
	UserID   string `json:"userId"`
	ColumnID string `json:"columnId"`
	Access   string `json:"access"`
}

// ColumnPermissionRow is the unified, frontend-friendly row shape
// returned by GET /api/v1/auth/permissions/columns for both the
// ?userId= and ?columnId= query modes.
//
// The pre-s-1054 handler projected a minimal shape
// ({id, columnId, columnName, access, userId, userNickname}) that
// dropped userType, userRole, and every audit column. Downstream
// code (AddColumnPermissionForm, BoardHeader.tsx owner-badge
// rendering) had to fall back to a separate getUsers() round-trip
// just to know whether the grantee was an AGENT, and the audit
// fields were unreachable. The unified row below carries:
//
//	userId            — id of the granted user
//	username          — login name of the granted user
//	nickname          — display name of the granted user
//	userType          — HUMAN | AGENT
//	userRole          — ADMIN | MEMBER | VIEWER
//	columnId          — id of the column
//	columnName        — name of the column
//	access            — READ | WRITE | ADMIN
//	id                — column_permissions row id (delete handle)
//	grantedByUserId   — actor who issued the grant (audit)
//	grantedByUsername — actor login (audit)
//	grantedByNickname — actor display name (audit)
//	grantedAt         — created_at of the row (audit)
//	expiresAt         — optional access expiry (null = never)
//	revokedAt         — soft-delete tombstone (null = active)
//
// Nullable audit columns are projected as *string without
// `omitempty` so the JSON encoder always emits the key (with a null
// value when the DB column is NULL). This keeps the field set
// identical between the two query modes — the same shape fix that
// s-1041 applied to board permissions.
//
// Revoked rows (revoked_at IS NOT NULL) are excluded from the
// listing: they no longer count as effective access and surfacing
// them to the management UI would let an operator re-revoke an
// already-revoked row and log a duplicate PERMISSION_REVOKE row.
type ColumnPermissionRow struct {
	UserID            string  `json:"userId"`
	Username          string  `json:"username"`
	Nickname          string  `json:"nickname"`
	UserType          string  `json:"userType"`
	UserRole          string  `json:"userRole"`
	ColumnID          string  `json:"columnId"`
	ColumnName        string  `json:"columnName"`
	Access            string  `json:"access"`
	ID                string  `json:"id"`
	GrantedByUserID   *string `json:"grantedByUserId"`
	GrantedByUsername *string `json:"grantedByUsername"`
	GrantedByNickname *string `json:"grantedByNickname"`
	GrantedAt         *string `json:"grantedAt"`
	ExpiresAt         *string `json:"expiresAt"`
	RevokedAt         *string `json:"revokedAt"`
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

		// Mirror GetPermissions: a board owner needs to enumerate
		// existing column grants to manage them. Without this
		// branch, an owner who can set/revoke via
		// SetColumnPermission / DeleteColumnPermission would still
		// be unable to list existing rows.
		if requestedColumnID != "" && !isAdmin(user) {
			boardID, err := getBoardIDForColumn(db, requestedColumnID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load column"})
				return
			}
			if !canManageBoardPermissions(db, user, boardID) {
				c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can list column permissions"})
				return
			}
		}

		var rows *sql.Rows
		var err error

		// Unified query (s-1054). Both ?userId= and ?columnId=
		// join columns + users + grantor so the projected row
		// always carries username / nickname / userType / userRole
		// / grantedByUserId / expiresAt / revokedAt. The branch
		// is only the WHERE clause + the revoked filter — keeping
		// the field set identical is the contract the task spec
		// calls out. INNER JOIN drops orphan rows the same way
		// GetPermissions does.
		if requestedColumnID != "" {
			rows, err = db.Query(`
				SELECT cp.id, cp.user_id, u.username, u.nickname, u.type, u.role,
				       cp.column_id, col.name, cp.access,
				       cp.granted_by_user_id, g.username, g.nickname,
				       cp.created_at, cp.expires_at, cp.revoked_at
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				JOIN users u ON cp.user_id = u.id
				LEFT JOIN users g ON g.id = cp.granted_by_user_id
				WHERE cp.column_id = ?
				  AND cp.revoked_at IS NULL
				ORDER BY cp.created_at ASC, cp.id ASC
			`, requestedColumnID)
		} else {
			rows, err = db.Query(`
				SELECT cp.id, cp.user_id, u.username, u.nickname, u.type, u.role,
				       cp.column_id, col.name, cp.access,
				       cp.granted_by_user_id, g.username, g.nickname,
				       cp.created_at, cp.expires_at, cp.revoked_at
				FROM column_permissions cp
				JOIN columns col ON cp.column_id = col.id
				JOIN users u ON cp.user_id = u.id
				LEFT JOIN users g ON g.id = cp.granted_by_user_id
				WHERE cp.user_id = ?
				  AND cp.revoked_at IS NULL
				ORDER BY cp.created_at ASC, cp.id ASC
			`, targetUserID)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		permissions := make([]ColumnPermissionRow, 0)
		for rows.Next() {
			var (
				id, userID, username, nickname, userType, userRole,
				columnID, columnName, access string
				grantedByUserID             sql.NullString
				grantedByUsername           sql.NullString
				grantedByNickname           sql.NullString
				grantedAt, expiresAt, revoked sql.NullTime
			)
			if err := rows.Scan(
				&id, &userID, &username, &nickname, &userType, &userRole,
				&columnID, &columnName, &access,
				&grantedByUserID, &grantedByUsername, &grantedByNickname,
				&grantedAt, &expiresAt, &revoked,
			); err != nil {
				log.Printf("[GetColumnPermissions] row scan failed: %v", err)
				continue
			}
			row := ColumnPermissionRow{
				UserID:     userID,
				Username:   username,
				Nickname:   nickname,
				UserType:   userType,
				UserRole:   userRole,
				ColumnID:   columnID,
				ColumnName: columnName,
				Access:     access,
				ID:         id,
			}
			if grantedByUserID.Valid {
				s := grantedByUserID.String
				row.GrantedByUserID = &s
			}
			if grantedByUsername.Valid {
				s := grantedByUsername.String
				row.GrantedByUsername = &s
			}
			if grantedByNickname.Valid {
				s := grantedByNickname.String
				row.GrantedByNickname = &s
			}
			if grantedAt.Valid {
				s := grantedAt.Time.UTC().Format(time.RFC3339)
				row.GrantedAt = &s
			}
			if expiresAt.Valid {
				s := expiresAt.Time.UTC().Format(time.RFC3339)
				row.ExpiresAt = &s
			}
			if revoked.Valid {
				s := revoked.Time.UTC().Format(time.RFC3339)
				row.RevokedAt = &s
			}
			permissions = append(permissions, row)
		}
		if err := rows.Err(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
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
