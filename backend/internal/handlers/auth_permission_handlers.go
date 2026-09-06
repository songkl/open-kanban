package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type SetPermissionRequest struct {
	UserID  string `json:"userId"`
	BoardID string `json:"boardId"`
	Access  string `json:"access"`
}

// PermissionRow is the canonical, unified row returned by
// GET /api/v1/auth/permissions for both ?userId= and ?boardId=.
//
// Prior to s-1041 the two branches of GetPermissions projected
// different shapes: the boardId variant returned {id, boardId,
// boardName, access, userId, userNickname} while the userId variant
// only returned {id, boardId, boardName, access}. Downstream code
// had to defensively probe both keys per row, which was fragile.
//
// The unified row carries the full set of fields needed by either
// caller side:
//
//	userId          — id of the granted user
//	username        — login name of the granted user
//	nickname        — display name of the granted user
//	userType        — HUMAN | AGENT
//	userRole        — ADMIN | MEMBER | VIEWER
//	boardId         — id of the board
//	boardName       — name of the board
//	access          — READ | WRITE | ADMIN
//	grantedByUserId   — id of the actor who issued the grant (audit)
//	grantedByUsername — login name of the granting actor (audit)
//	grantedByNickname — display name of the granting actor (audit)
//	grantedAt         — when the row was created (audit)
//	expiresAt         — optional access expiry (null = never)
//	revokedAt         — soft-delete tombstone (null = active)
//
// The frontend (BoardPermission in types/kanban.ts) keys off
// `nickname`, `userType`, `id`, `userId`, `boardId`, `boardName`,
// `access` and (for the owner badge) `ownerAgentId`. ownerAgentId
// and id are kept on the row for delete + owner-badge rendering
// even though the task spec lists them as implicit.
//
// Nullable audit columns are projected as *string without
// `omitempty` so the JSON encoder always emits the key (with a
// null value when the DB column is NULL). This is what locks the
// field set identical between the two query modes — a key that
// is sometimes present and sometimes missing is the same
// regression the task spec is fixing.
type PermissionRow struct {
	UserID            string  `json:"userId"`
	Username          string  `json:"username"`
	Nickname          string  `json:"nickname"`
	UserType          string  `json:"userType"`
	UserRole          string  `json:"userRole"`
	BoardID           string  `json:"boardId"`
	BoardName         string  `json:"boardName"`
	Access            string  `json:"access"`
	ID                string  `json:"id"`
	OwnerAgentID      *string `json:"ownerAgentId"`
	GrantedByUserID   *string `json:"grantedByUserId"`
	GrantedByUsername *string `json:"grantedByUsername"`
	GrantedByNickname *string `json:"grantedByNickname"`
	GrantedAt         *string `json:"grantedAt"`
	ExpiresAt         *string `json:"expiresAt"`
	RevokedAt         *string `json:"revokedAt"`
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

		// Unified query (s-1041). Both ?userId= and ?boardId=
		// join the users + boards tables so the projected row
		// always carries userNickname / userType / userRole /
		// grantedByUserId / expiresAt / revokedAt. The branch is
		// only the WHERE clause, never the projection — keeping
		// the field set identical is the contract the task spec
		// calls out.
		//
		// LEFT JOIN on users / boards is not used: an orphaned
		// board_permissions row (FK CASCADE makes this extremely
		// unlikely in practice) would surface as empty
		// username/nickname and confuse the UI. INNER JOIN drops
		// orphans, which is the desired behaviour for a
		// management surface.
		var rows *sql.Rows
		var err error

		if requestedBoardID != "" {
			rows, err = db.Query(`
				SELECT bp.id, bp.user_id, u.username, u.nickname, u.type, u.role,
				       bp.board_id, b.name, bp.access, bp.owner_agent_id,
				       bp.granted_by_user_id, g.username, g.nickname,
				       bp.created_at, bp.expires_at, bp.revoked_at
				FROM board_permissions bp
				JOIN boards b ON bp.board_id = b.id
				JOIN users u  ON bp.user_id  = u.id
				LEFT JOIN users g ON g.id = bp.granted_by_user_id
				WHERE bp.board_id = ?
				ORDER BY bp.created_at ASC, bp.id ASC
			`, requestedBoardID)
		} else {
			rows, err = db.Query(`
				SELECT bp.id, bp.user_id, u.username, u.nickname, u.type, u.role,
				       bp.board_id, b.name, bp.access, bp.owner_agent_id,
				       bp.granted_by_user_id, g.username, g.nickname,
				       bp.created_at, bp.expires_at, bp.revoked_at
				FROM board_permissions bp
				JOIN boards b ON bp.board_id = b.id
				JOIN users u  ON bp.user_id  = u.id
				LEFT JOIN users g ON g.id = bp.granted_by_user_id
				WHERE bp.user_id = ?
				ORDER BY bp.created_at ASC, bp.id ASC
			`, targetUserID)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get"})
			return
		}
		defer rows.Close()

		// Pre-allocate as empty (not nil) so the JSON encoder
		// emits "permissions":[] instead of "permissions":null on
		// a user with no grants. The CLAUDE API style guide
		// requires [] over null.
		permissions := make([]PermissionRow, 0)
		for rows.Next() {
			var (
				id, userID, username, nickname, userType, userRole,
				boardID, boardName, access string
				ownerAgentID                sql.NullString
				grantedByUserID             sql.NullString
				grantedByUsername           sql.NullString
				grantedByNickname           sql.NullString
				grantedAt, expiresAt, revoked sql.NullTime
			)
			if err := rows.Scan(
				&id, &userID, &username, &nickname, &userType, &userRole,
				&boardID, &boardName, &access, &ownerAgentID,
				&grantedByUserID, &grantedByUsername, &grantedByNickname,
				&grantedAt, &expiresAt, &revoked,
			); err != nil {
				log.Printf("[GetPermissions] row scan failed: %v", err)
				continue
			}
			row := PermissionRow{
				UserID:    userID,
				Username:  username,
				Nickname:  nickname,
				UserType:  userType,
				UserRole:  userRole,
				BoardID:   boardID,
				BoardName: boardName,
				Access:    access,
				ID:        id,
			}
			if ownerAgentID.Valid {
				s := ownerAgentID.String
				row.OwnerAgentID = &s
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

		// When the caller scopes the request to a single board,
		// also return the "invitable" candidate list (s-1039): every
		// user that does NOT yet hold effective access on the
		// board. The auth gate already enforced canManageBoardPermissions
		// above for non-admin callers, so it is safe to expose the
		// same shape as /api/v1/auth/users-visible. We keep the
		// existing `permissions` field unchanged so this endpoint
		// stays backwards compatible.
		var candidates []gin.H
		if requestedBoardID != "" {
			candidates = loadPermissionCandidates(db, requestedBoardID)
		}

		response := gin.H{"permissions": permissions}
		if candidates != nil {
			response["candidates"] = candidates
		}

		c.JSON(http.StatusOK, response)
	}
}

// loadPermissionCandidates returns the set of users that can still be
// invited to the named board — i.e. anyone without an effective
// board_permissions row. "Effective" mirrors the contract used by
// /api/v1/auth/users-visible: access set, not revoked, not past
// expiry. The board owner is excluded because their own row already
// grants ADMIN access via owner_agent_id.
//
// Returned as []gin.H to keep the response shape identical to the
// users-visible endpoint (userId / username / nickname / type / role).
// An empty slice — not nil — is returned for a board with no
// candidates so JSON consumers always see an array.
func loadPermissionCandidates(db *sql.DB, boardID string) []gin.H {
	rows, err := db.Query(`
		SELECT u.id, u.username, u.nickname, u.type, u.role
		FROM users u
		LEFT JOIN board_permissions bp
			ON bp.user_id = u.id
			AND bp.board_id = ?
			AND bp.access IS NOT NULL
			AND bp.revoked_at IS NULL
			AND (bp.expires_at IS NULL OR bp.expires_at > ?)
		WHERE bp.id IS NULL
		ORDER BY u.created_at DESC
	`, boardID, time.Now())
	if err != nil {
		log.Printf("[GetPermissions] candidates query failed (board=%s): %v", boardID, err)
		return []gin.H{}
	}
	defer rows.Close()

	candidates := make([]gin.H, 0)
	for rows.Next() {
		var id, username, nickname, userType, role string
		if err := rows.Scan(&id, &username, &nickname, &userType, &role); err == nil {
			candidates = append(candidates, gin.H{
				"userId":   id,
				"username": username,
				"nickname": nickname,
				"type":     userType,
				"role":     role,
			})
		}
	}
	return candidates
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
		// update is safe. The audit columns are populated so a
		// re-grant clears any prior revoked_at / revoked_by stamp —
		// granting is a reactivation, not a new add.
		_, err := db.Exec(`
			REPLACE INTO board_permissions (
				id, user_id, board_id, access,
				granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes
			)
			VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '')
		`, permID, req.UserID, req.BoardID, req.Access, user.ID)
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

// DeletePermission revokes a board permission row. The endpoint is
// a soft-delete: the row stays in board_permissions but its
// revoked_at / revoked_by_user_id columns are stamped so loadBoardAccess
// (and the loadPermissionCandidates filter) treat the grant as
// inactive. The audit trail survives the revoke — a follow-up
// re-grant clears the tombstone via the REPLACE in SetPermission.
//
// "Row already gone" stays a 200 idempotent response (the operator
// retrying after a network blip should not see a 500). A "row
// already revoked" state is also treated as a no-op: the activity
// log records one PERMISSION_REVOKE row per distinct revoke, never
// one per retry.
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

		// Capture the affected user / board / revocation state
		// before the UPDATE so we can (a) enforce the
		// already-revoked idempotency rule and (b) record an
		// activity row that references the board by name.
		var (
			targetUserID, boardID, boardName string
			ownerID, existingRevokedAt       sql.NullString
		)
		if err := db.QueryRow(`
			SELECT bp.user_id, bp.board_id, COALESCE(b.name, ''),
			       bp.owner_agent_id, bp.revoked_at
			FROM board_permissions bp
			LEFT JOIN boards b ON bp.board_id = b.id
			WHERE bp.id = ?
		`, permID).Scan(&targetUserID, &boardID, &boardName, &ownerID, &existingRevokedAt); err != nil {
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
		if ownerID.Valid && ownerID.String == targetUserID {
			c.JSON(http.StatusForbidden, gin.H{"error": "Cannot revoke the board owner's permission"})
			return
		}

		// Idempotent soft delete: a row that is already revoked
		// (revoked_at NOT NULL) is treated as a no-op so retrying
		// the same DELETE does not stamp a new revoked_at /
		// revoked_by pair and does not log a duplicate
		// PERMISSION_REVOKE activity row. The check happens before
		// the UPDATE so the original revoked_at timestamp is
		// preserved exactly.
		if existingRevokedAt.Valid {
			c.JSON(http.StatusOK, gin.H{"success": true})
			return
		}

		// Soft-delete: stamp revoked_at + revoked_by_user_id so
		// loadBoardAccess's `revoked_at IS NULL` filter treats the
		// row as inactive, but the audit trail (granted_by /
		// original access / timestamps) stays intact for the
		// permission-activities endpoint. The where clause is the
		// safety net: if the row was deleted between the load and
		// the UPDATE (e.g. concurrent request), the UPDATE matches
		// zero rows and we surface a 500 so the caller can retry.
		res, err := db.Exec(`
			UPDATE board_permissions
			SET revoked_at = CURRENT_TIMESTAMP,
			    revoked_by_user_id = ?
			WHERE id = ?
			  AND revoked_at IS NULL
		`, user.ID, permID)
		if err != nil {
			log.Printf("[DeletePermission] UPDATE board_permissions failed (id=%s): %v", permID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			// Another concurrent request revoked the row between
			// our load and our UPDATE. Treat as a successful
			// idempotent delete — same outcome the caller wanted.
			c.JSON(http.StatusOK, gin.H{"success": true})
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

		stmt, err := tx.Prepare(`REPLACE INTO board_permissions (
			id, user_id, board_id, access,
			granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes
		) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '')`)
		if err != nil {
			log.Printf("[BulkSetPermissions] failed to prepare statement: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk set permissions"})
			return
		}
		defer stmt.Close()

		granted := make([]gin.H, 0, len(cleaned))
		for _, uid := range cleaned {
			permID := generateID()
			if _, err := stmt.Exec(permID, uid, req.BoardID, req.Access, user.ID); err != nil {
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

// BulkGrantEntry is one element of the grants:[] body field. Each
// entry describes a single (user, board) permission grant. expires_at
// is optional; when present the handler stamps it onto the row so the
// existing expires_at filter (loadBoardAccess, GetMyBoardPermissions,
// loadPermissionCandidates) treats the grant as expired automatically.
//
// expires_at is intentionally kept as *string here (not time.Time) so
// the handler can validate the string explicitly and report bad
// values via the skipped list rather than failing the entire request.
type BulkGrantEntry struct {
	UserID    string  `json:"userId"`
	Access    string  `json:"access"`
	ExpiresAt *string `json:"expiresAt,omitempty"`
}

type BulkGrantPermissionsRequest struct {
	BoardID string           `json:"boardId"`
	Grants  []BulkGrantEntry `json:"grants"`
}

// bulkGrantMaxEntries caps the number of grants accepted in a
// single BulkGrantPermissions call. The cap is intentionally lower
// than the bulk-set endpoint (which uses 200) because this endpoint
// targets the "onboarding a whole team" use case where per-grant
// variation matters and the row-count growth of a single call is
// expected to stay in the low double digits. 50 is small enough to
// keep the transaction window tight while leaving comfortable room
// for real onboarding scenarios.
const bulkGrantMaxEntries = 50

// BulkGrantPermissions grants board access to many users in one
// round trip, with per-grant access level and optional expires_at.
// Unlike BulkSetPermissions (which uniformly overwrites every
// target's access on a single board), this endpoint is an
// "onboarding" surface: it preserves any row the target user
// already holds and returns the survivors in the skipped list with
// a reason, so the UI can show the operator exactly which users
// were added vs which were already present.
//
// Body shape:
//
//	{
//	  "boardId": "...",
//	  "grants": [
//	    {"userId": "u1", "access": "READ"},
//	    {"userId": "u2", "access": "WRITE", "expiresAt": "2027-01-01T00:00:00Z"}
//	  ]
//	}
//
// Response (always 200 unless a hard validation fails before any DB
// work): { granted: [userId, ...], skipped: [{userId, reason}, ...] }
//
// Reason codes used in skipped[]:
//   - "unknown_user"      the userId does not resolve to any users row
//   - "invalid_access"    access is not one of {READ, WRITE, ADMIN}
//   - "invalid_expires_at"  expiresAt is present but unparseable / in the past
//   - "owner_protected"   the userId is the board's recorded owner
//   - "already_granted"   a non-revoked, non-expired row already exists
//
// Validation order:
//  1. Auth (401).
//  2. Body shape: boardId / grants must be present, grants non-empty
//     after dedupe (400).
//  3. Cap: more than bulkGrantMaxEntries → 400 (the request itself
//     is rejected; we don't silently truncate).
//  4. Authorization: caller must own the board or be a global ADMIN
//     (403). Mirrors SetPermission / BulkSetPermissions / DeletePermission.
//  5. Board existence (404 if missing).
//  6. Per-entry validation: dedupe, classify each entry as
//     granted-or-skipped with a reason. The transaction only sees
//     the granted subset; skipped entries never touch the DB.
//  7. Owner protection: any grant targeting the board's owner is
//     demoted to skipped with reason "owner_protected" before
//     commit (instead of rejecting the whole batch). The board
//     must always have exactly one owner; overwriting it via a
//     bulk grant would silently corrupt the owner stamp.
//
// The whole rewrite runs in a single transaction so a partial
// failure cannot leave the board with half-applied grants. Cache
// invalidation runs only after commit, mirroring BulkSetPermissions.
// One PERMISSION_BULK_GRANT activity row is recorded per call with
// the count of granted + skipped entries.
func BulkGrantPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req BulkGrantPermissionsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}
		if req.BoardID == "" || len(req.Grants) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Incomplete parameters"})
			return
		}
		if len(req.Grants) > bulkGrantMaxEntries {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Too many grants in one request"})
			return
		}

		if !canManageBoardPermissions(db, user, req.BoardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can assign permissions"})
			return
		}

		// Board must exist (404 if not). Owner_agent_id is read in
		// the same round trip so the per-entry owner-protection
		// check below doesn't need a second query.
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
			log.Printf("[BulkGrantPermissions] failed to load board %s: %v", req.BoardID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board"})
			return
		}

		validAccesses := map[string]bool{"READ": true, "WRITE": true, "ADMIN": true}

		// Pre-validation pass. Each entry ends up in exactly one
		// of three buckets:
		//   - applied:    will be inserted in the transaction
		//   - skipped:    reason reported in the response
		//   - duplicate:  collapsed against an earlier entry
		//
		// Duplicates keep the FIRST entry's access / expiresAt so
		// the response is deterministic. Order in the response
		// mirrors the request order so the UI can correlate
		// line-by-line.
		type pending struct {
			access    string
			expiresAt sql.NullTime
		}
		applied := make([]pending, 0, len(req.Grants))
		grantedIDs := make([]string, 0, len(req.Grants))
		skipped := make([]gin.H, 0)
		seen := make(map[string]int, len(req.Grants)) // userId → index in applied or skipped

		// Bulk-resolve every userId in one IN-list query so the
		// "unknown_user" check is a single round trip regardless of
		// batch size. The placeholder count must match the request
		// length — any mismatch is a bug we want to surface.
		placeholders := strings.Repeat("?,", len(req.Grants))
		placeholders = placeholders[:len(placeholders)-1]
		argList := make([]interface{}, len(req.Grants))
		for i, g := range req.Grants {
			argList[i] = g.UserID
		}
		existingRows, err := db.Query(
			"SELECT id FROM users WHERE id IN ("+placeholders+")", argList...,
		)
		if err != nil {
			log.Printf("[BulkGrantPermissions] failed to query users: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to verify users"})
			return
		}
		found := make(map[string]struct{}, len(req.Grants))
		for existingRows.Next() {
			var id string
			if err := existingRows.Scan(&id); err == nil {
				found[id] = struct{}{}
			}
		}
		existingRows.Close()

		// Bulk-resolve existing rows on this board so the
		// "already_granted" classification is one query. We
		// consider a row "already granted" when it is
		// non-revoked AND not past its expires_at, mirroring the
		// effective-access semantics used by loadPermissionCandidates.
		existingRows2, err := db.Query(
			"SELECT user_id FROM board_permissions WHERE board_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND user_id IN ("+placeholders+")",
			append([]interface{}{req.BoardID, time.Now()}, argList...)...,
		)
		if err != nil {
			log.Printf("[BulkGrantPermissions] failed to query existing rows: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to verify existing rows"})
			return
		}
		alreadyGranted := make(map[string]struct{}, len(req.Grants))
		for existingRows2.Next() {
			var id string
			if err := existingRows2.Scan(&id); err == nil {
				alreadyGranted[id] = struct{}{}
			}
		}
		existingRows2.Close()

		for _, g := range req.Grants {
			if g.UserID == "" {
				continue
			}
			if _, dup := seen[g.UserID]; dup {
				continue
			}
			seen[g.UserID] = len(applied) + len(skipped)

			// Unknown user: not in the bulk-resolved found map.
			if _, ok := found[g.UserID]; !ok {
				skipped = append(skipped, gin.H{"userId": g.UserID, "reason": "unknown_user"})
				continue
			}
			if !validAccesses[g.Access] {
				skipped = append(skipped, gin.H{"userId": g.UserID, "reason": "invalid_access"})
				continue
			}
			// Owner protection: never overwrite the owner stamp.
			// We surface this as a skip rather than a 403 because
			// the rest of the batch is still safe to apply and the
			// operator usually wants to know the owner was excluded
			// instead of seeing the whole request fail.
			if ownerID.Valid && g.UserID == ownerID.String {
				skipped = append(skipped, gin.H{"userId": g.UserID, "reason": "owner_protected"})
				continue
			}
			if _, ok := alreadyGranted[g.UserID]; ok {
				skipped = append(skipped, gin.H{"userId": g.UserID, "reason": "already_granted"})
				continue
			}
			// expires_at, if provided, must be parseable and in
			// the future. An unparseable value is the operator's
			// bug, not a server fault, so we report it via
			// skipped instead of failing the whole batch.
			var expiresAt sql.NullTime
			if g.ExpiresAt != nil && *g.ExpiresAt != "" {
				t, perr := parseGrantExpiresAt(*g.ExpiresAt)
				if perr != nil || !t.After(time.Now()) {
					skipped = append(skipped, gin.H{"userId": g.UserID, "reason": "invalid_expires_at"})
					continue
				}
				expiresAt = sql.NullTime{Time: t, Valid: true}
			}
			applied = append(applied, pending{access: g.Access, expiresAt: expiresAt})
			grantedIDs = append(grantedIDs, g.UserID)
		}

		// No-op batch: every entry was skipped. Return 200 with
		// empty granted list so the UI can still update its
		// progress display without treating this as a failure.
		if len(applied) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"success": true,
				"boardId": req.BoardID,
				"granted": []string{},
				"skipped": skipped,
			})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			log.Printf("[BulkGrantPermissions] failed to begin tx: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk grant permissions"})
			return
		}
		defer tx.Rollback()

		// REPLACE INTO is portable across MySQL and SQLite (see
		// SetPermission for the long version). The bulk-resolved
		// "already_granted" check above guarantees no entry in
		// `applied` collides with a row that currently has
		// effective access, but a row that already exists with
		// revoked_at set or expires_at in the past IS eligible
		// for re-grant — REPLACE rewrites that row in place,
		// clearing the soft-delete tombstone / refreshing the
		// expiry. The (user_id, board_id) UNIQUE constraint is
		// the safety net if that assumption ever breaks: a
		// duplicate would still resolve to the same row without
		// losing data, just with a fresh id.
		stmt, err := tx.Prepare(`REPLACE INTO board_permissions (
			id, user_id, board_id, access,
			granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes
		) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '')`)
		if err != nil {
			log.Printf("[BulkGrantPermissions] failed to prepare statement: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk grant permissions"})
			return
		}
		defer stmt.Close()

		for i, p := range applied {
			uid := grantedIDs[i]
			permID := generateID()
			var expiresArg interface{}
			if p.expiresAt.Valid {
				expiresArg = p.expiresAt.Time
			}
			if _, err := stmt.Exec(permID, uid, req.BoardID, p.access, user.ID, expiresArg); err != nil {
				log.Printf("[BulkGrantPermissions] REPLACE INTO failed for user=%s board=%s: %v", uid, req.BoardID, err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": "Failed to bulk grant permissions: " + err.Error(),
				})
				return
			}
		}

		if err := tx.Commit(); err != nil {
			log.Printf("[BulkGrantPermissions] commit failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to bulk grant permissions"})
			return
		}

		// Cache invalidation runs after commit so a partial failure
		// cannot evict cache entries for users whose grant never
		// landed. tokenCache / permissionCache hold the only state
		// that's stale until the new access is reflected, so we
		// drop both for every granted user.
		for _, uid := range grantedIDs {
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
			"granted_count="+strconv.Itoa(len(applied))+" skipped_count="+strconv.Itoa(len(skipped)),
			c.ClientIP(),
			getRequestSource(c),
		)

		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"boardId": req.BoardID,
			"granted": grantedIDs,
			"skipped": skipped,
		})
	}
}

// parseGrantExpiresAt accepts the formats the UI is expected to
// send and rejects everything else. We deliberately stay strict
// here: an unparseable expires_at is reported via the skipped list
// (reason "invalid_expires_at") instead of silently defaulting to
// never-expires, because a silently-stripped expiry on a
// permission grant would be a security-relevant surprise.
func parseGrantExpiresAt(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02T15:04:05", s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02 15:04:05", s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, nil
	}
	return time.Time{}, errGrantExpiresAt
}

var errGrantExpiresAt = &grantExpiresAtErr{}

type grantExpiresAtErr struct{}

func (e *grantExpiresAtErr) Error() string {
	return "invalid expires_at format"
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
