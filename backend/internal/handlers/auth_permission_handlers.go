package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"

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

type BulkSetPermissionsRequest struct {
	BoardID string   `json:"boardId"`
	UserIDs []string `json:"userIds"`
	Access  string   `json:"access"`
}

// bulkPermissionMaxUsers caps the number of users accepted in a
// single BulkSetPermissions call. The handler does a single
// SELECT … IN (?) lookup and N REPLACE statements inside one
// transaction, so the upper bound is mostly about preventing an
// accidentally-large request from holding a write lock too long.
// 200 was chosen because it comfortably exceeds the realistic size
// of a single board's collaborator list (boards in this project are
// typically shared with a single-digit-to-low-double-digit number of
// users) without forcing callers to chunk legitimate bulk grants.
const bulkPermissionMaxUsers = 200

// BulkSetPermissions grants the same access level to many users on
// a single board in one round trip. The endpoint is the bulk
// counterpart of SetPermission and exists so the UI does not have to
// fire 50 sequential POST /permissions requests when a board owner
// onboards a whole team at once.
//
// Validation order matters and is mirrored on SetPermission /
// DeletePermission so the behaviour is consistent across the
// permission-management surface:
//
//  1. Auth: getCurrentUser must resolve, else 401.
//  2. Body shape: boardId / userIds / access must all be present
//     and non-empty, else 400.
//  3. Size cap: more than bulkPermissionMaxUsers users in one
//     request is rejected up-front so an oversized request can't
//     hold a transaction open for too long.
//  4. Access enum: access must be one of {READ, WRITE, ADMIN}.
//  5. Deduplication: empty strings are dropped and duplicates are
//     collapsed before any DB work, so the loop and the activity
//     row both reflect the final user set.
//  6. Authorization: the caller must own the board or be a global
//     ADMIN — the same rule SetPermission enforces via
//     canManageBoardPermissions.
//  7. Owner row protection: if the board's owner_agent_id is in
//     the batch, the entire request is rejected 403. Mirrors
//     DeletePermission's owner-protection semantics: bulk-modify
//     could otherwise silently overwrite the owner stamp in a way
//     that is hard to audit after the fact.
//  8. Existence checks: every requested userId must resolve to a
//     row in users (missing ids are returned together in a single
//     400 so the UI can surface them at once); the board must
//     exist (404 otherwise).
//
// The whole rewrite runs in a single transaction so a partial
// failure cannot leave the board with half-applied grants. After
// commit, every cached (user, board) entry and every cached token
// for the affected users is evicted so the new access takes effect
// on the next request. A single PERMISSION_BULK_GRANT activity row
// is recorded — one row per batch, not one per user — so the audit
// log stays readable even for very large grants.
func BulkSetPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req BulkSetPermissionsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}
		if req.BoardID == "" || req.Access == "" || len(req.UserIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		if len(req.UserIDs) > bulkPermissionMaxUsers {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Too many users in one request"})
			return
		}

		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}
		if !validAccesses[req.Access] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid permission value"})
			return
		}

		// Deduplicate and drop empty ids in a single pass so the
		// downstream loop, the unknown-user check, and the activity
		// row all see the same set. Stable order is not required —
		// the caller already submitted a list, not a map.
		seen := make(map[string]struct{}, len(req.UserIDs))
		cleaned := make([]string, 0, len(req.UserIDs))
		for _, uid := range req.UserIDs {
			if uid == "" {
				continue
			}
			if _, ok := seen[uid]; ok {
				continue
			}
			seen[uid] = struct{}{}
			cleaned = append(cleaned, uid)
		}
		if len(cleaned) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		if !canManageBoardPermissions(db, user, req.BoardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can assign permissions"})
			return
		}

		// Board must exist (404 if not) and owner_agent_id must
		// not be in the batch (403 if it is). Both checks are
		// pre-flight so we never start a transaction only to
		// roll it back for a deterministic validation failure.
		var ownerID sql.NullString
		var boardName string
		err := db.QueryRow(
			"SELECT b.name, (SELECT bp.owner_agent_id FROM board_permissions bp WHERE bp.board_id = b.id AND bp.owner_agent_id IS NOT NULL LIMIT 1) FROM boards b WHERE b.id = ?",
			req.BoardID,
		).Scan(&boardName, &ownerID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
				return
			}
			log.Printf("[BulkSetPermissions] failed to load board %s: %v", req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board"})
			return
		}
		if ownerID.Valid {
			for _, uid := range cleaned {
				if uid == ownerID.String {
					c.JSON(http.StatusForbidden, gin.H{"error": "Cannot bulk-modify owner's permission row"})
					return
				}
			}
		}

		// Existence check: build one IN-list query and report every
		// missing id at once so the UI can correct them in a
		// single round-trip. The placeholder count must match the
		// cleaned slice — any mismatch is a bug we want to surface.
		placeholders := strings.Repeat("?,", len(cleaned))
		placeholders = placeholders[:len(placeholders)-1]
		args := make([]interface{}, len(cleaned))
		for i, uid := range cleaned {
			args[i] = uid
		}
		existingRows, err := db.Query(
			"SELECT id FROM users WHERE id IN ("+placeholders+")", args...,
		)
		if err != nil {
			log.Printf("[BulkSetPermissions] failed to query users: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to verify users"})
			return
		}
		found := make(map[string]struct{}, len(cleaned))
		for existingRows.Next() {
			var id string
			if err := existingRows.Scan(&id); err == nil {
				found[id] = struct{}{}
			}
		}
		existingRows.Close()
		var missing []string
		for _, uid := range cleaned {
			if _, ok := found[uid]; !ok {
				missing = append(missing, uid)
			}
		}
		if len(missing) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":          "Unknown user ids",
				"unknownUserIds": missing,
			})
			return
		}

		// Transaction: REPLACE INTO is portable across MySQL and
		// SQLite (see SetPermission for the long version). Each
		// row's id is freshly generated — the (user_id, board_id)
		// UNIQUE constraint makes the upsert atomic, and no FK
		// references board_permissions.id so the row id rotating
		// on update is safe.
		tx, err := db.Begin()
		if err != nil {
			log.Printf("[BulkSetPermissions] failed to begin tx: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk set permissions"})
			return
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(`REPLACE INTO board_permissions (id, user_id, board_id, access) VALUES (?, ?, ?, ?)`)
		if err != nil {
			log.Printf("[BulkSetPermissions] failed to prepare statement: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk set permissions"})
			return
		}
		defer stmt.Close()

		granted := make([]gin.H, 0, len(cleaned))
		for _, uid := range cleaned {
			permID := generateID()
			if _, err := stmt.Exec(permID, uid, req.BoardID, req.Access); err != nil {
				log.Printf("[BulkSetPermissions] REPLACE INTO failed for user=%s board=%s: %v", uid, req.BoardID, err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": "Failed to bulk set permissions: " + err.Error(),
				})
				return
			}
			granted = append(granted, gin.H{
				"userId": uid,
				"access": req.Access,
			})
		}

		if err := tx.Commit(); err != nil {
			log.Printf("[BulkSetPermissions] commit failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk set permissions"})
			return
		}

		// Cache invalidation runs after commit so a partial failure
		// cannot evict cache entries for users whose grant never
		// landed. InvalidateUser drops every cached (user, *) entry
		// for the affected user, and InvalidateResource is fired
		// once at the end so any third party's stale (?, boardId)
		// entry is dropped too.
		for _, uid := range cleaned {
			tokenCache.DeleteByUserID(uid)
			permissionCache.InvalidateUser(uid)
		}
		permissionCache.InvalidateResource(req.BoardID)

		LogActivity(
			db,
			user.ID,
			"PERMISSION_BULK_GRANT",
			"BOARD",
			req.BoardID,
			boardName,
			"user_count="+strconv.Itoa(len(cleaned))+" access="+req.Access,
			c.ClientIP(),
			getRequestSource(c),
		)

		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"boardId": req.BoardID,
			"granted": granted,
			"count":   len(granted),
		})
	}
}

type TransferOwnershipRequest struct {
	BoardID        string `json:"boardId"`
	NewOwnerUserID string `json:"newOwnerUserId"`
}

// TransferOwnership hands ownership of a board from the current
// owner to another user who already has at least one permission
// row on the board. After the transfer:
//
//   - the new owner's row is stamped with owner_agent_id so the
//     owner short-circuit in loadBoardAccess keeps granting ADMIN;
//   - the old owner's row keeps its explicit access (we never
//     delete it) and has owner_agent_id cleared — they retain
//     whatever access the row currently has, typically ADMIN via
//     the row access string itself.
//
// Only the current owner or a global ADMIN can call this. Global
// ADMINs are allowed so operators can recover ownership for boards
// whose owner has left the team without having to first grant
// themselves an ADMIN row.
//
// The whole rewrite runs in a single transaction so a partial
// failure cannot leave the board with two owners (or zero).
func TransferOwnership(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req TransferOwnershipRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}
		if req.BoardID == "" || req.NewOwnerUserID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}

		// Refuse to transfer ownership to oneself — that would be
		// a no-op rewrite that still produces an activity row and
		// an unnecessary cache flush. Reject it explicitly so the
		// operator gets a clean error instead of a confusing 200.
		if req.NewOwnerUserID == user.ID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "New owner must be different from current owner"})
			return
		}

		// Authorize: global ADMIN or the board's current owner.
		// Mirrors the rule used by SetPermission /
		// DeletePermission (see canManageBoardPermissions) but
		// skips the per-board ADMIN-row shortcut: transferring
		// ownership is a meta-capability reserved to the recorded
		// owner and global admins.
		if !isAdmin(user) {
			isOwner, err := IsBoardOwner(db, user.ID, req.BoardID)
			if err != nil {
				log.Printf("[TransferOwnership] failed to check ownership (user=%s board=%s): %v", user.ID, req.BoardID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check ownership"})
				return
			}
			if !isOwner {
				c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can transfer ownership"})
				return
			}
		}

		var boardName string
		if err := db.QueryRow("SELECT name FROM boards WHERE id = ?", req.BoardID).Scan(&boardName); err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
				return
			}
			log.Printf("[TransferOwnership] failed to load board %s: %v", req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board"})
			return
		}

		// Verify the target user exists — a transfer to a
		// non-existent user would leave the FK intact in SQLite
		// (FK enforcement is off by default in some test configs)
		// but produce a confusing "no row updated" failure on
		// the COMMIT side. Catch it up front instead.
		var targetExists bool
		if err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE id = ?)", req.NewOwnerUserID).Scan(&targetExists); err != nil {
			log.Printf("[TransferOwnership] failed to check target user %s: %v", req.NewOwnerUserID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check target user"})
			return
		}
		if !targetExists {
			c.JSON(http.StatusNotFound, gin.H{"error": "Target user not found"})
			return
		}

		// The target must already have a board_permissions row
		// for this board. Without one, a transfer would leave the
		// new owner with an owner stamp on a row that does not
		// exist — every subsequent permission check would route
		// through "no row" and the board would effectively have no
		// manageable owner. The spec is explicit about this:
		// "不允许转移给无权限的人，否则会变成无主".
		var hasExistingRow bool
		if err := db.QueryRow(
			"SELECT EXISTS(SELECT 1 FROM board_permissions WHERE user_id = ? AND board_id = ?)",
			req.NewOwnerUserID, req.BoardID,
		).Scan(&hasExistingRow); err != nil {
			log.Printf("[TransferOwnership] failed to check existing row (user=%s board=%s): %v", req.NewOwnerUserID, req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check target permission"})
			return
		}
		if !hasExistingRow {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Target user must already have a permission on this board"})
			return
		}

		// Capture old owner user ID and nickname for the activity
		// log. The handler may be invoked by a global ADMIN who is
		// not the recorded owner — we want the log to mention the
		// human-readable actor + the actual owner being replaced.
		var oldOwnerID sql.NullString
		if err := db.QueryRow(
			"SELECT owner_agent_id FROM board_permissions WHERE board_id = ? AND owner_agent_id IS NOT NULL LIMIT 1",
			req.BoardID,
		).Scan(&oldOwnerID); err != nil && err != sql.ErrNoRows {
			log.Printf("[TransferOwnership] failed to read current owner (board=%s): %v", req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read current owner"})
			return
		}

		var oldOwnerNickname, newOwnerNickname string
		if oldOwnerID.Valid {
			db.QueryRow("SELECT nickname FROM users WHERE id = ?", oldOwnerID.String).Scan(&oldOwnerNickname)
		}
		db.QueryRow("SELECT nickname FROM users WHERE id = ?", req.NewOwnerUserID).Scan(&newOwnerNickname)

		tx, err := db.Begin()
		if err != nil {
			log.Printf("[TransferOwnership] failed to begin tx: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to transfer ownership"})
			return
		}
		defer tx.Rollback()

		// Step 1: clear the old owner's stamp. We deliberately
		// keep their access row intact (and their access value)
		// so they remain usable on the board — only the
		// owner-of-the-board metadata moves.
		if _, err := tx.Exec(
			"UPDATE board_permissions SET owner_agent_id = NULL, access = COALESCE(access, 'ADMIN') WHERE user_id = ? AND board_id = ?",
			oldOwnerID.String, req.BoardID,
		); err != nil {
			log.Printf("[TransferOwnership] failed to clear old owner (user=%s board=%s): %v", oldOwnerID.String, req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear old owner"})
			return
		}

		// Step 2: stamp the new owner. Access on the new owner's
		// row is forced to ADMIN so they can manage the board
		// immediately even if their previous access was lower.
		// The owner short-circuit in loadBoardAccess also grants
		// ADMIN to the new owner — both paths reinforce the
		// upgrade, so dropping access to READ here would still
		// leave them with effective ADMIN via short-circuit.
		if _, err := tx.Exec(
			"UPDATE board_permissions SET owner_agent_id = ?, access = 'ADMIN' WHERE user_id = ? AND board_id = ?",
			req.NewOwnerUserID, req.NewOwnerUserID, req.BoardID,
		); err != nil {
			log.Printf("[TransferOwnership] failed to stamp new owner (user=%s board=%s): %v", req.NewOwnerUserID, req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to stamp new owner"})
			return
		}

		if err := tx.Commit(); err != nil {
			log.Printf("[TransferOwnership] commit failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to transfer ownership"})
			return
		}

		// Flush every cached session / permission entry that the
		// change could affect. The old owner's effective access
		// drops (they lose the owner short-circuit and now rely on
		// their explicit access row), the new owner's effective
		// access rises, and any third party whose cached
		// (user, board) entry was stale relative to this
		// ownership change needs to re-read.
		if oldOwnerID.Valid {
			tokenCache.DeleteByUserID(oldOwnerID.String)
			permissionCache.InvalidateUser(oldOwnerID.String)
		}
		tokenCache.DeleteByUserID(req.NewOwnerUserID)
		permissionCache.InvalidateUser(req.NewOwnerUserID)
		permissionCache.InvalidateResource(req.BoardID)

		details := "from=" + oldOwnerID.String + " to=" + req.NewOwnerUserID
		if oldOwnerNickname != "" || newOwnerNickname != "" {
			details = "from=" + oldOwnerNickname + " (" + oldOwnerID.String + ") to=" + newOwnerNickname + " (" + req.NewOwnerUserID + ")"
		}
		LogActivity(
			db,
			user.ID,
			"PERMISSION_TRANSFER",
			"BOARD",
			req.BoardID,
			boardName,
			details,
			c.ClientIP(),
			getRequestSource(c),
		)

		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"boardId": req.BoardID,
			"newOwnerUserId": req.NewOwnerUserID,
		})
	}
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
