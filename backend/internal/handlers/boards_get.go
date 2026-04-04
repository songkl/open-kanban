package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func GetBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		var id, name, description, shortAlias string
		var deleted bool
		var createdAt, updatedAt time.Time
		var columnCount int

		err := db.QueryRow(`
			SELECT b.id, b.name, COALESCE(b.description, ''), COALESCE(b.short_alias, ''), b.deleted, b.created_at, b.updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
			FROM boards b
			WHERE b.id = ? AND b.deleted = false
		`, boardID).Scan(&id, &name, &description, &shortAlias, &deleted, &createdAt, &updatedAt, &columnCount)

		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":          id,
			"name":        name,
			"description": description,
			"shortAlias":  shortAlias,
			"deleted":     deleted,
			"createdAt":   createdAt,
			"updatedAt":   updatedAt,
			"_count": gin.H{
				"columns": columnCount,
			},
		})
	}
}
