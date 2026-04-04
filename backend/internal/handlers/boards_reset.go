package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

func ResetBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to reset this board"})
			return
		}

		var boardName string
		err := db.QueryRow("SELECT name FROM boards WHERE id = ? AND deleted = false", boardID).Scan(&boardName)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
			return
		}
		defer tx.Rollback()

		if err := resetBoardData(tx, boardID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear board data"})
			return
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_UPDATE", "BOARD", boardID, boardName, "重置看板", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":   boardID,
			"name": boardName,
		})
	}
}
