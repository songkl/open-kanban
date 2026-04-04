package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func GetBoards(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(`
			SELECT id, name, COALESCE(description, ''), deleted, created_at, updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
			FROM boards b
			WHERE deleted = false
			ORDER BY created_at ASC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
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
					"id":          id,
					"name":        name,
					"description": description,
					"deleted":     deleted,
					"createdAt":   createdAt,
					"updatedAt":   updatedAt,
					"_count": gin.H{
						"columns": columnCount,
					},
				})
			}
		}

		c.JSON(http.StatusOK, boards)
	}
}
