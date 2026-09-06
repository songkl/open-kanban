package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// GetBoards returns the list of non-deleted boards.
//
// The endpoint stays public (the spec for boards-list v1 said
// anonymous clients still need to render the board picker) but
// behaves differently based on the calling user and per-board
// visibility (boards.is_public):
//
//   - Anonymous (no Authorization / kanban-token): returns every
//     non-deleted board with `is_public=true`. Private boards
//     stay hidden so they cannot be enumerated from the public
//     list. `effectiveAccess: ""` and `isOwner: false` as before.
//
//   - Global ADMIN: returns every non-deleted board regardless of
//     is_public, with `effectiveAccess: "ADMIN"`. ADMINs need to
//     audit private boards without being added as explicit
//     grants, so the visibility toggle is not a way to hide a
//     board from admins.
//
//   - Any other logged-in user: returns every board the user has
//     at least READ access on (or owns) PLUS every board with
//     `is_public=true`. Owners (board_permissions.owner_agent_id
//     == user.id) are surfaced with `effectiveAccess: "ADMIN"`
//     even if their global role is MEMBER / VIEWER. Private
//     boards the user has no relationship with stay filtered out.
//
// Result order is owner > ADMIN > WRITE > READ (descending) for
// authenticated callers; ascending by created_at is preserved as
// the tiebreaker so the listing stays stable across calls.
func GetBoards(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)

		if user == nil {
			writeAnonymousBoards(c, db)
			return
		}

		writeAuthenticatedBoards(c, db, user)
	}
}

// writeAnonymousBoards emits every non-deleted PUBLIC board with
// empty access flags. Used when no user context is attached to
// the request (no Authorization header, no kanban-token cookie,
// or the token failed to resolve to an enabled user).
//
// Private boards are filtered out: anonymous callers cannot tell
// a private board exists, let alone its id, name, or column
// count. The same query also returns the column_count subselect
// so the response shape stays identical to the authenticated
// path (callers that consume effectiveAccess / isOwner keep
// working).
func writeAnonymousBoards(c *gin.Context, db *sql.DB) {
	rows, err := db.Query(`
		SELECT id, name, COALESCE(description, ''), deleted, created_at, updated_at,
			(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
		FROM boards b
		WHERE deleted = false AND is_public = 1
		ORDER BY created_at ASC
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get boards"})
		return
	}
	defer rows.Close()

	boards := []gin.H{}
	for rows.Next() {
		var id, name, description string
		var deleted bool
		var createdAt, updatedAt time.Time
		var columnCount int
		if err := rows.Scan(&id, &name, &description, &deleted, &createdAt, &updatedAt, &columnCount); err == nil {
			boards = append(boards, gin.H{
				"id":              id,
				"name":            name,
				"description":     description,
				"isPublic":        true,
				"deleted":         deleted,
				"createdAt":       createdAt,
				"updatedAt":       updatedAt,
				"effectiveAccess": "",
				"isOwner":         false,
				"_count": gin.H{
					"columns": columnCount,
				},
			})
		}
	}

	c.JSON(http.StatusOK, boards)
}

// writeAuthenticatedBoards emits the boards visible to `user` with
// per-row `effectiveAccess` / `isOwner` flags. ADMINs see every
// board; other roles see only boards where they have a row in
// board_permissions (with the owner row mapping to ADMIN access)
// PLUS every board with `is_public=true`.
func writeAuthenticatedBoards(c *gin.Context, db *sql.DB, user *models.User) {
	// One SQL round trip: LEFT JOIN board_permissions for this
	// user. Rows without a matching permission row surface as
	// access="" / owner_agent_id=NULL — exactly what the access
	// calculation below expects. Sort buckets owner > ADMIN >
	// WRITE > READ with created_at as tiebreaker so ADMIN users
	// and non-ADMIN users get a stable ordering.
	//
	// The WHERE clause mirrors the visibility contract:
	//   - admins see everything (handled below with `admin`)
	//   - non-admins see (granted OR public) AND not deleted
	rows, err := db.Query(`
		SELECT b.id, b.name, COALESCE(b.description, ''), b.is_public, b.deleted, b.created_at, b.updated_at,
			(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count,
			COALESCE(bp.access, '') as access,
			bp.owner_agent_id
		FROM boards b
		LEFT JOIN board_permissions bp ON bp.board_id = b.id AND bp.user_id = ?
		WHERE b.deleted = false
		ORDER BY
			CASE
				WHEN bp.owner_agent_id IS NOT NULL AND bp.owner_agent_id = ? THEN 4
				WHEN bp.access = 'ADMIN' THEN 3
				WHEN bp.access = 'WRITE' THEN 2
				WHEN bp.access = 'READ' THEN 1
				ELSE 0
			END DESC,
			b.created_at ASC
	`, user.ID, user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get boards"})
		return
	}
	defer rows.Close()

	boards := []gin.H{}
	admin := isAdmin(user)
	for rows.Next() {
		var id, name, description, access string
		var isPublic bool
		var deleted bool
		var createdAt, updatedAt time.Time
		var columnCount int
		var ownerAgentID sql.NullString
		if err := rows.Scan(&id, &name, &description, &isPublic, &deleted, &createdAt, &updatedAt, &columnCount, &access, &ownerAgentID); err != nil {
			continue
		}

		isOwner := ownerAgentID.Valid && ownerAgentID.String == user.ID

		// Visibility filter for non-admins: a non-admin user
		// must have a grant (or ownership flag) OR the board
		// must be public. Without this filter, users with no
		// permissions would receive the entire board list
		// (including private boards) with effectiveAccess=""
		// — defeating both the access filter and the visibility
		// contract.
		if !admin && !isOwner && access == "" && !isPublic {
			continue
		}

		effectiveAccess := access
		switch {
		case admin:
			// Global ADMIN always surfaces as ADMIN, regardless
			// of whether they have an explicit grant row.
			effectiveAccess = "ADMIN"
		case isOwner:
			// Owner short-circuit mirrors the rest of the
			// codebase: a board owner gets ADMIN access on the
			// board even if their row's stored access is lower
			// or empty.
			effectiveAccess = "ADMIN"
		}

		boards = append(boards, gin.H{
			"id":              id,
			"name":            name,
			"description":     description,
			"isPublic":        isPublic,
			"deleted":         deleted,
			"createdAt":       createdAt,
			"updatedAt":       updatedAt,
			"effectiveAccess": effectiveAccess,
			"isOwner":         isOwner,
			"_count": gin.H{
				"columns": columnCount,
			},
		})
	}

	c.JSON(http.StatusOK, boards)
}
