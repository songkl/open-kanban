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
		_, err = tx.Exec(
			"INSERT INTO boards (id, name, description, short_alias, task_counter, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			boardID, req.Name, req.Description, shortAlias, 1000, false, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
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

		var board gin.H
		board = gin.H{
			"id":          boardID,
			"name":        req.Name,
			"description": req.Description,
			"shortAlias":  shortAlias,
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
		db.QueryRow("SELECT name, COALESCE(description, '') FROM boards WHERE id = ?", id).Scan(&oldName, &oldDesc)

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

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET name = ?, description = ?, updated_at = ? WHERE id = ?",
			req.Name, req.Description, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		LogActivity(db, user.ID, "BOARD_UPDATE", "BOARD", id, req.Name, details, c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":          id,
			"name":        req.Name,
			"description": req.Description,
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

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET deleted = ?, updated_at = ? WHERE id = ?",
			true, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		LogActivity(db, user.ID, "BOARD_DELETE", "BOARD", id, "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
