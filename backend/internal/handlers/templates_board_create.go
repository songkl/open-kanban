package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type CreateFromTemplateRequest struct {
	Name       string `json:"name"`
	TemplateID string `json:"templateId"`
	BoardID    string `json:"boardId,omitempty"`
}

func CreateBoardFromTemplate(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req CreateFromTemplateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		if req.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board name is required"})
			return
		}

		boardID := req.BoardID
		if boardID == "" {
			boardID = generateID()
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}
		defer tx.Rollback()

		now := time.Now()
		_, err = tx.Exec(
			"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			boardID, req.Name, false, now, now,
		)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				c.JSON(http.StatusConflict, gin.H{"error": "Board ID is already in use, please try again"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		if req.TemplateID != "" {
			var columnsConfig string
			err = db.QueryRow("SELECT columns_config FROM templates WHERE id = ?", req.TemplateID).Scan(&columnsConfig)
			if err != nil && err != sql.ErrNoRows {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get template"})
				return
			}

			if columnsConfig != "" {
				var columns []ColumnConfig
				if err := json.Unmarshal([]byte(columnsConfig), &columns); err == nil {
					for _, col := range columns {
						colID := generateID()
						_, err = tx.Exec(
							"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
							colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
						)
						if err != nil {
							c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
							return
						}
					}
				}
			}
		} else {
			for _, col := range defaultColumns {
				colID := generateID()
				_, err = tx.Exec(
					"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
				)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
					return
				}
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_CREATE", "BOARD", boardID, req.Name, "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":        boardID,
			"name":      req.Name,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}
