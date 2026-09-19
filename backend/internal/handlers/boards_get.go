package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// GetBoard returns a single non-deleted board by id.
//
// The endpoint is public (no RequireAuth), but when a valid user
// is attached to the request the response is enriched with:
//
//   - `effectiveAccess`: "ADMIN" for global ADMINs and for board
//     owners (regardless of stored access); the user's stored
//     access otherwise; "" when no user or no grant.
//   - `isOwner`: true if the calling user matches the board's
//     owner_agent_id.
//
// Backward compatibility: the endpoint always returns 200 with
// `effectiveAccess: ""` for anonymous callers and for users with
// no grant on an existing board — anti-enumeration lives on the
// list endpoint, not here. Private boards are still resolvable by
// direct id so the user who knows the URL can deep-link.
func GetBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		user := getCurrentUser(c, db)
		userID := ""
		if user != nil {
			userID = user.ID
		}

		var id, name, description, shortAlias, access string
		var deleted, isPublic bool
		var createdAt, updatedAt time.Time
		var columnCount int
		var ownerAgentID sql.NullString

		err := db.QueryRow(`
			SELECT b.id, b.name, COALESCE(b.description, ''), COALESCE(b.short_alias, ''), b.deleted, b.is_public, b.created_at, b.updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count,
				COALESCE(bp.access, '') as access,
				bp.owner_agent_id
			FROM boards b
			LEFT JOIN board_permissions bp ON bp.board_id = b.id AND bp.user_id = ?
			WHERE b.id = ? AND b.deleted = false
		`, userID, boardID).Scan(&id, &name, &description, &shortAlias, &deleted, &isPublic, &createdAt, &updatedAt, &columnCount, &access, &ownerAgentID)

		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		effectiveAccess := ""
		isOwner := false
		if user != nil {
			isOwner = ownerAgentID.Valid && ownerAgentID.String == user.ID
			switch {
			case isAdmin(user):
				effectiveAccess = "ADMIN"
			case isOwner:
				// Owner short-circuit matches the rest of the
				// codebase: a board owner is treated as ADMIN
				// even if their stored access is lower.
				effectiveAccess = "ADMIN"
			default:
				effectiveAccess = access
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"id":              id,
			"name":            name,
			"description":     description,
			"shortAlias":      shortAlias,
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
}