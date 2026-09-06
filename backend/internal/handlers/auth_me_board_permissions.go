package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetMyBoardPermissions reports the calling user's effective
// permission state on a single board. The frontend uses it to
// decide whether to surface the "manage permissions" affordance
// (BoardHeader.tsx used to key off `currentUser?.role === 'ADMIN'`
// alone, which hid the controls from MEMBER/VIEWER-as-owner users).
//
// The response shape is intentionally narrow:
//
//	{
//	  "boardId": "...",
//	  "effectiveAccess": "READ" | "WRITE" | "ADMIN" | "",
//	  "isOwner": true|false,
//	  "canManageBoardPermissions": true|false,
//	  "canManageColumnPermissions": true|false
//	}
//
// Anti-enumeration: when the user has no grant on the board AND
// is not the board's owner, the endpoint returns 404 instead of
// 200 with an empty payload. This prevents the request from being
// used to probe whether arbitrary boardIds exist — callers cannot
// distinguish "board missing" from "board exists but no access".
// Note that the cache layer is intentionally NOT invalidated by
// this read-only handler; writes already flush the affected user
// via SetPermission / DeletePermission (landed in s-1010).
func GetMyBoardPermissions(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Query("boardId")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "boardId is required"})
			return
		}

		isOwner, err := IsBoardOwner(db, user.ID, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board permissions"})
			return
		}

		effectiveAccess := GetEffectiveBoardAccess(db, user.ID, boardID, user.Role)

		// Anti-enumeration gate: a user with no grant and no
		// ownership flag cannot tell whether the board exists,
		// so return 404 (rather than 200 with empty payload)
		// for both "board missing" and "board exists, no
		// access". Callers should treat this as "you don't
		// have a relationship with this board" — full stop.
		if effectiveAccess == "" && !isOwner {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"boardId":                      boardID,
			"effectiveAccess":              effectiveAccess,
			"isOwner":                      isOwner,
			"canManageBoardPermissions":    canManageBoardPermissions(db, user, boardID),
			"canManageColumnPermissions":   isAdmin(user),
		})
	}
}