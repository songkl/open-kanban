package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"open-kanban/internal/utils"
)

func CreateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req CreateBoardRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		boardID := req.ID
		if boardID == "" {
			boardID = utils.ToPinyinSlug(req.Name)
			if boardID == "" {
				boardID = generateID()
			}
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}
		defer tx.Rollback()

		shortAlias := req.ShortAlias
		if shortAlias == "" {
			shortAlias = utils.ToBoardAlias(req.Name)
		}
		shortAlias = ensureUniqueBoardAlias(tx, shortAlias)

		now := time.Now()
		// Default new boards to public so the feature is
		// opt-in: callers who don't send isPublic keep the
		// pre-feature behaviour. The column-level DEFAULT 1
		// covers the same case for direct DB inserts.
		isPublic := true
		if req.IsPublic != nil {
			isPublic = *req.IsPublic
		}
		_, err = tx.Exec(
			"INSERT INTO boards (id, name, description, short_alias, task_counter, deleted, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			boardID, req.Name, req.Description, shortAlias, 1000, false, isPublic, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		// Stamp the creator as the board owner. owner_agent_id on
		// board_permissions grants the row's user ADMIN on the
		// board regardless of their global role — a MEMBER who
		// creates a board can still manage its permissions,
		// columns, and tasks. Without this row, only global
		// ADMINs would have board-management rights. The audit
		// columns (granted_by / expires / revoked_*) are written
		// as NULL defaults so the row starts in its "active"
		// state; granted_by_user_id is the creator because the
		// owner grant is self-issued at create-time.
		_, err = tx.Exec(
			"INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes) VALUES (?, ?, ?, ?, 'ADMIN', ?, NULL, NULL, NULL, '')",
			generateID(), user.ID, boardID, user.ID, user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to grant creator ownership"})
			return
		}

		for _, col := range defaultColumns {
			colID := generateColumnIDForTx(tx, col.Name, boardID)
			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
				return
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_CREATE", "BOARD", boardID, req.Name, "", c.ClientIP(), getRequestSource(c))

		publishBoardCreated(boardID, req.Name, shortAlias, req.Description,
			sql.NullTime{Time: now, Valid: true},
			sql.NullTime{Time: now, Valid: true},
		)

		var board gin.H
		board = gin.H{
			"id":          boardID,
			"name":        req.Name,
			"description": req.Description,
			"shortAlias":  shortAlias,
			"isPublic":    isPublic,
			"deleted":     false,
			"createdAt":   now,
			"updatedAt":   now,
		}

		c.JSON(http.StatusOK, board)
	}
}

func UpdateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, id, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this board"})
			return
		}

		var req UpdateBoardRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		var oldName, oldDesc string
		var oldIsPublic bool
		err := db.QueryRow("SELECT name, COALESCE(description, ''), is_public FROM boards WHERE id = ?", id).Scan(&oldName, &oldDesc, &oldIsPublic)
		// Pre-flight read only powers the activity-log "name
		// changed / visibility flipped" message and the cache
		// invalidation guard. None of those matter for a
		// missing row — preserve the legacy behaviour of
		// returning 200 with the caller's payload and updating
		// zero rows, matching what callers (and the existing
		// handler test) used to rely on.
		boardExists := err == nil

		details := ""
		if req.Name != "" && req.Name != oldName {
			details = fmt.Sprintf("名称: '%s' → '%s'", oldName, req.Name)
		}
		if req.Description != oldDesc {
			if details != "" {
				details += "; "
			}
			details += fmt.Sprintf("说明: '%s' → '%s'", oldDesc, req.Description)
		}

		// Pointer semantics: missing key keeps the previous
		// visibility, explicit value flips it. Only invalidate
		// the permission cache when visibility actually changed,
		// since a stale cache entry for a flipped-from-private
		// board would let an unauthorized user keep seeing it
		// for up to permissionCacheDuration.
		newIsPublic := oldIsPublic
		if req.IsPublic != nil && boardExists && *req.IsPublic != oldIsPublic {
			newIsPublic = *req.IsPublic
			if details != "" {
				details += "; "
			}
			visibilityLabel := "公开"
			if !newIsPublic {
				visibilityLabel = "私有"
			}
			details += fmt.Sprintf("可见性: %s", visibilityLabel)
		}

		now := time.Now()
		_, err = db.Exec(
			"UPDATE boards SET name = ?, description = ?, is_public = ?, updated_at = ? WHERE id = ?",
			req.Name, req.Description, newIsPublic, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		if boardExists && req.IsPublic != nil && *req.IsPublic != oldIsPublic {
			permissionCache.InvalidateResource(id)
		}

		LogActivity(db, user.ID, "BOARD_UPDATE", "BOARD", id, req.Name, details, c.ClientIP(), getRequestSource(c))

		changes := boardChangeEntries(req, oldName, oldDesc)
		publishBoardUpdated(id, req.Name, "", req.Description, changes, sql.NullTime{Time: now, Valid: true})

		c.JSON(http.StatusOK, gin.H{
			"id":          id,
			"name":        req.Name,
			"description": req.Description,
			"isPublic":    newIsPublic,
			"updatedAt":   now,
		})
	}
}

func DeleteBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, id, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this board"})
			return
		}

		// Capture the column IDs that belong to this board BEFORE
		// the soft-delete (or the cascading purge) so we can flush
		// their cache entries. Soft-delete doesn't touch column
		// rows today, but a future "hard delete with cascade" path
		// would otherwise leave stale (user, columnID) entries
		// pointing at IDs that no longer resolve to a column.
		columnIDs := collectColumnIDsForBoard(db, id)

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET deleted = ?, updated_at = ? WHERE id = ?",
			true, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		// Invalidate the cached (user, board) entry for every
		// affected user (resource-wide) AND every (user, column)
		// entry tied to the cascaded columns. Without this, a
		// user hitting the deleted board would keep getting
		// stale access from cache until the 5-minute TTL.
		permissionCache.InvalidateResource(id)
		for _, colID := range columnIDs {
			permissionCache.InvalidateResource(colID)
		}

		LogActivity(db, user.ID, "BOARD_DELETE", "BOARD", id, "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func collectColumnIDsForBoard(db *sql.DB, boardID string) []string {
	rows, err := db.Query("SELECT id FROM columns WHERE board_id = ?", boardID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}
