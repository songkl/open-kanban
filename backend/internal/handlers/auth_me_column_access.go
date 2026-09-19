package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ColumnAccessInfo is the per-column effective-access summary the
// frontend uses to gate task-creation affordances. canCreateTask
// mirrors the same rule CreateTask enforces (column-level grant
// ≥ WRITE, falling back to board-level grant ≥ WRITE), so the UI
// never shows an enabled button that the server would reject.
//
// canModify / canDelete surface the access level needed for
// edit-in-place and column-deletion flows so other affordances
// (drag-to-column, edit pencil, column dropdown) can use the same
// payload rather than making a second round trip.
type ColumnAccessInfo struct {
	EffectiveAccess string `json:"effectiveAccess"`
	CanCreateTask   bool   `json:"canCreateTask"`
	CanModify       bool   `json:"canModify"`
	CanDelete       bool   `json:"canDelete"`
}

// GetMyColumnAccess returns the calling user's effective access
// for every column under a board. The endpoint exists so the
// frontend can render create/edit/delete affordances against the
// actual server-side rule instead of guessing from role.
//
// Anti-enumeration: when the user has no grant on the board AND
// is not the board's owner, the endpoint returns 404 instead of
// 200 with an empty payload — same behavior as
// GetMyBoardPermissions. ADMIN short-circuits to all-ADMIN
// regardless of stored grants.
func GetMyColumnAccess(db *sql.DB) gin.HandlerFunc {
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

		boardAccess := GetEffectiveBoardAccess(db, user.ID, boardID, user.Role)

		if boardAccess == "" && !isOwner {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}

		columnAccess, err := GetEffectiveColumnAccessForBoard(db, user.ID, boardID, user.Role)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load column permissions"})
			return
		}

		boardCanCreate := accessLevelAtLeast(boardAccess, "WRITE")
		boardCanModify := accessLevelAtLeast(boardAccess, "WRITE")
		boardCanDelete := accessLevelAtLeast(boardAccess, "ADMIN")

		result := make(map[string]ColumnAccessInfo, len(columnAccess))
		for colID, colAccess := range columnAccess {
			effective := colAccess
			if effective == "" {
				effective = boardAccess
			}
			result[colID] = ColumnAccessInfo{
				EffectiveAccess: effective,
				CanCreateTask:   boardCanCreate || accessLevelAtLeast(colAccess, "WRITE"),
				CanModify:       boardCanModify || accessLevelAtLeast(colAccess, "WRITE"),
				CanDelete:       boardCanDelete || accessLevelAtLeast(colAccess, "ADMIN"),
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"boardId":          boardID,
			"boardAccess":      boardAccess,
			"isOwner":          isOwner,
			"columns":          result,
		})
	}
}
