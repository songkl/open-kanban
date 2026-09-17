package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// parseSQLiteTimestamp tries the common layouts SQLite hands
// back for a DATETIME column when the result is computed via an
// aggregate (e.g. MAX(t.updated_at)) rather than read straight
// from a column. The mattn/go-sqlite3 driver returns such values
// as driver.Value=string, so the columns have to be parsed
// manually before they can be scanned into time.Time.
func parseSQLiteTimestamp(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	layouts := []string{
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02T15:04:05.999999999-07:00",
		"2006-01-02T15:04:05.999999999Z",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// scanLastActive reads the raw driver value for `last_active_at`
// (a string when sourced from a subquery) and converts it into a
// time.Time. Falls back to the board's own updated_at when the
// subquery returns no rows.
func scanLastActive(raw sql.NullString, fallback time.Time) time.Time {
	if !raw.Valid {
		return fallback
	}
	if t, ok := parseSQLiteTimestamp(raw.String); ok {
		return t
	}
	return fallback
}

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
//
// Every row carries three helper fields for the boards-page UI:
//   - `taskCount`: number of tasks across all columns of the
//     board (0 for empty boards).
//   - `lastActiveAt`: most recent task updated_at for the board,
//     falling back to board.updated_at when the board has no
//     tasks. Lets the client sort boards by recent activity
//     without an extra round trip.
//   - `ownerNickname`: nickname of the user whose
//     board_permissions row carries owner_agent_id. Empty when
//     the board has no recorded owner.
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
			(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count,
			COALESCE(
				(SELECT u.nickname FROM board_permissions bp
				 JOIN users u ON u.id = bp.owner_agent_id
				 WHERE bp.board_id = b.id AND bp.owner_agent_id IS NOT NULL
				 LIMIT 1),
				''
			) as owner_nickname,
			COALESCE(
				(SELECT COUNT(*) FROM tasks t JOIN columns c ON t.column_id = c.id WHERE c.board_id = b.id),
				0
			) as task_count,
			(SELECT MAX(t.updated_at) FROM tasks t JOIN columns c ON t.column_id = c.id WHERE c.board_id = b.id) as last_active_at
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
		var columnCount, taskCount int
		var ownerNickname string
		var lastActiveRaw sql.NullString
		if err := rows.Scan(&id, &name, &description, &deleted, &createdAt, &updatedAt, &columnCount, &ownerNickname, &taskCount, &lastActiveRaw); err == nil {
			effective := scanLastActive(lastActiveRaw, updatedAt)
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
				"taskCount":       taskCount,
				"lastActiveAt":    effective,
				"ownerNickname":   ownerNickname,
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
			bp.owner_agent_id,
			COALESCE(
				(SELECT u.nickname FROM board_permissions bp2
				 JOIN users u ON u.id = bp2.owner_agent_id
				 WHERE bp2.board_id = b.id AND bp2.owner_agent_id IS NOT NULL
				 LIMIT 1),
				''
			) as owner_nickname,
			COALESCE(
				(SELECT COUNT(*) FROM tasks t JOIN columns c ON t.column_id = c.id WHERE c.board_id = b.id),
				0
			) as task_count,
			(SELECT MAX(t.updated_at) FROM tasks t JOIN columns c ON t.column_id = c.id WHERE c.board_id = b.id) as last_active_at
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
		var columnCount, taskCount int
		var ownerAgentID sql.NullString
		var ownerNickname string
		var lastActiveRaw sql.NullString
		if err := rows.Scan(&id, &name, &description, &isPublic, &deleted, &createdAt, &updatedAt, &columnCount, &access, &ownerAgentID, &ownerNickname, &taskCount, &lastActiveRaw); err != nil {
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

		effective := scanLastActive(lastActiveRaw, updatedAt)

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
			"taskCount":       taskCount,
			"lastActiveAt":    effective,
			"ownerNickname":   ownerNickname,
			"_count": gin.H{
				"columns": columnCount,
			},
		})
	}

	c.JSON(http.StatusOK, boards)
}
