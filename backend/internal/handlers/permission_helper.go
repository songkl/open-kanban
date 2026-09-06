package handlers

import (
	"database/sql"
	"net/http"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

func isAdmin(user *models.User) bool {
	return user != nil && user.Role == "ADMIN"
}

// IsLastAdmin reports whether targetUserID is the last enabled
// ADMIN user in the system. Returns true when removing targetUserID
// from the enabled ADMIN set would leave zero admins. This is used to
// guard against demoting, disabling or deleting the last admin so the
// system never becomes unmanageable.
func IsLastAdmin(db *sql.DB, targetUserID string) (bool, error) {
	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND enabled = 1 AND id != ?",
		targetUserID,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == 0, nil
}

func accessLevelAtLeast(access, required string) bool {
	levels := map[string]int{"READ": 1, "WRITE": 2, "ADMIN": 3}
	if _, ok := levels[required]; !ok {
		return false
	}
	userLevel, ok := levels[access]
	return ok && userLevel >= levels[required]
}

// loadBoardAccess returns the user's effective access on a board.
// The result is cached (including the empty string for "no access")
// so repeated checks don't hit the DB. ADMIN is treated as a
// universal true at the call site, so it never reaches this loader.
//
// A user who is recorded as the board's owner (board_permissions.
// owner_agent_id == user_id) is always granted ADMIN access — this
// is what gives the creator of a board automatic board management
// rights even if their global role is MEMBER or VIEWER. The owner
// short-circuit is reflected in the cached value so subsequent
// checks stay a cache hit instead of round-tripping through the DB.
func loadBoardAccess(db *sql.DB, userID, boardID string) string {
	if userID == "" || boardID == "" {
		return ""
	}
	if cached, ok := permissionCache.Get(userID, boardID); ok {
		return cached
	}
	var access string
	var ownerID sql.NullString
	err := db.QueryRow(
		"SELECT access, owner_agent_id FROM board_permissions WHERE user_id = ? AND board_id = ?",
		userID, boardID,
	).Scan(&access, &ownerID)
	if err != nil {
		// sql.ErrNoRows or any other failure: cache "" so we
		// don't keep hammering the DB for users with no grant.
		access = ""
	} else if ownerID.Valid && ownerID.String == userID {
		// Owner short-circuit: a board's creator (recorded as the
		// owner_agent_id on their own permission row) is treated
		// as ADMIN regardless of the access string. This keeps the
		// board manageable for non-global-admin users and aligns
		// SetPermission / DeletePermission, which already accept
		// owner-grants.
		access = "ADMIN"
	}
	permissionCache.Set(userID, boardID, access)
	return access
}

// IsBoardOwner reports whether userID owns boardID. A board owner is
// recorded as owner_agent_id on their own board_permissions row, set
// when the board is created. Owners implicitly have ADMIN access on
// the board even if their global role is MEMBER or VIEWER.
func IsBoardOwner(db *sql.DB, userID, boardID string) (bool, error) {
	if userID == "" || boardID == "" {
		return false, nil
	}
	var ownerID sql.NullString
	err := db.QueryRow(
		"SELECT owner_agent_id FROM board_permissions WHERE user_id = ? AND board_id = ?",
		userID, boardID,
	).Scan(&ownerID)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	return ownerID.Valid && ownerID.String == userID, nil
}

// canManageBoardPermissions reports whether user is allowed to grant
// or revoke board_permissions rows on boardID. Global ADMIN always
// qualifies; otherwise only the board's owner (recorded via
// owner_agent_id) qualifies — the per-board ADMIN row granted by
// another admin is intentionally NOT enough to manage permissions,
// because the spec treats permission management as a meta-capability
// reserved to the owner and global admins.
func canManageBoardPermissions(db *sql.DB, user *models.User, boardID string) bool {
	if isAdmin(user) {
		return true
	}
	if user == nil || boardID == "" {
		return false
	}
	owner, err := IsBoardOwner(db, user.ID, boardID)
	if err != nil {
		return false
	}
	return owner
}

// loadColumnAccess returns the user's effective access on a column.
// See loadBoardAccess for the negative-cache rationale.
func loadColumnAccess(db *sql.DB, userID, columnID string) string {
	if userID == "" || columnID == "" {
		return ""
	}
	if cached, ok := permissionCache.Get(userID, columnID); ok {
		return cached
	}
	var access string
	err := db.QueryRow(
		"SELECT access FROM column_permissions WHERE user_id = ? AND column_id = ?",
		userID, columnID,
	).Scan(&access)
	if err != nil {
		access = ""
	}
	permissionCache.Set(userID, columnID, access)
	return access
}

func checkBoardAccess(db *sql.DB, userID, boardID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || boardID == "" {
		return false
	}
	access := loadBoardAccess(db, userID, boardID)
	return accessLevelAtLeast(access, requiredAccess)
}

func checkColumnAccess(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || columnID == "" {
		return false
	}
	access := loadColumnAccess(db, userID, columnID)
	return accessLevelAtLeast(access, requiredAccess)
}

func checkColumnAccessWithBoardFallback(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
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

func requireNonViewer(c *gin.Context, user *models.User) bool {
	if user == nil || user.Role == "VIEWER" {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot perform this action"})
		return true
	}
	return false
}

func canModifyTask(db *sql.DB, user *models.User, taskID string) (bool, error) {
	if user == nil {
		return false, nil
	}
	switch user.Role {
	case "ADMIN":
		return true, nil
	case "VIEWER":
		return false, nil
	}
	var createdBy sql.NullString
	err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", taskID).Scan(&createdBy)
	if err != nil {
		return false, err
	}
	return createdBy.Valid && createdBy.String == user.ID, nil
}

// GetEffectiveBoardAccess returns the user's effective access on a
// single board, reading through the cache when warm. Thin wrapper
// over loadBoardAccess so handlers / API endpoints can expose
// "what access does this user have" without re-implementing the
// cache logic.
func GetEffectiveBoardAccess(db *sql.DB, userID, boardID, userRole string) string {
	if userRole == "ADMIN" {
		return "ADMIN"
	}
	return loadBoardAccess(db, userID, boardID)
}

// GetEffectiveColumnAccessForBoard returns every column under
// boardID along with the user's effective access on each, in one
// round trip. Result is keyed by column ID; columns the user has
// no direct grant on are reported as "" (the handler should fall
// back to the board-level grant). ADMIN users short-circuit to a
// full "ADMIN" map without touching the DB.
//
// The returned map is safe to read after the call; the cache
// entries are warmed for any user that already had a cached
// access. Callers that need to consult the cache for subsequent
// single-column checks can rely on those warm entries.
func GetEffectiveColumnAccessForBoard(db *sql.DB, userID, boardID, userRole string) (map[string]string, error) {
	result := make(map[string]string)
	if boardID == "" {
		return result, nil
	}

	if userRole == "ADMIN" {
		rows, err := db.Query("SELECT id FROM columns WHERE board_id = ?", boardID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				result[id] = "ADMIN"
			}
		}
		return result, nil
	}

	if userID == "" {
		// No user, no per-column grants — still return the column
		// IDs so the caller can render an empty access map.
		rows, err := db.Query("SELECT id FROM columns WHERE board_id = ?", boardID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				result[id] = ""
			}
		}
		return result, nil
	}

	// One query that joins columns to column_permissions for this
	// user+board. Columns missing from the join have NULL access,
	// which we surface as "" (caller falls back to board access).
	rows, err := db.Query(`
		SELECT c.id, COALESCE(cp.access, '')
		FROM columns c
		LEFT JOIN column_permissions cp ON cp.column_id = c.id AND cp.user_id = ?
		WHERE c.board_id = ?
	`, userID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var columnID, access string
		if err := rows.Scan(&columnID, &access); err != nil {
			continue
		}
		result[columnID] = access
		if access != "" {
			permissionCache.Set(userID, columnID, access)
		}
	}
	return result, nil
}
