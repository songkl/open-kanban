package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type Template struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	BoardID       string    `json:"boardId,omitempty"`
	ColumnsConfig string    `json:"columnsConfig"`
	IncludeTasks  bool      `json:"includeTasks"`
	CreatedBy     string    `json:"createdBy,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type ColumnConfig struct {
	Name     string `json:"name"`
	Position int    `json:"position"`
	Color    string `json:"color"`
	Status   string `json:"status,omitempty"`
}

type SaveTemplateRequest struct {
	Name         string `json:"name" validate:"required,max=100"`
	BoardID      string `json:"boardId" validate:"required"`
	IncludeTasks bool   `json:"includeTasks"`
}

func GetTemplates(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		rows, err := db.Query(`
			SELECT id, name, board_id, columns_config, include_tasks, created_by, created_at, updated_at
			FROM templates
			ORDER BY created_at DESC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get template"})
			return
		}
		defer rows.Close()

		var templates []gin.H
		for rows.Next() {
			var id, name, boardID, columnsConfig, createdBy string
			var includeTasks bool
			var createdAt, updatedAt time.Time
			if err := rows.Scan(&id, &name, &boardID, &columnsConfig, &includeTasks, &createdBy, &createdAt, &updatedAt); err == nil {
				templates = append(templates, gin.H{
					"id":            id,
					"name":          name,
					"boardId":       boardID,
					"columnsConfig": columnsConfig,
					"includeTasks":  includeTasks,
					"createdBy":     createdBy,
					"createdAt":     createdAt,
					"updatedAt":     updatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, templates)
	}
}

func SaveTemplate(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req SaveTemplateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		if req.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Template name is required"})
			return
		}

		var columnsConfig string
		if req.BoardID != "" {
			colRows, err := db.Query(`
				SELECT name, status, position, color
				FROM columns WHERE board_id = ? ORDER BY position ASC
			`, req.BoardID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column info"})
				return
			}
			defer colRows.Close()

			var columns []ColumnConfig
			for colRows.Next() {
				var col ColumnConfig
				var status sql.NullString
				if err := colRows.Scan(&col.Name, &status, &col.Position, &col.Color); err == nil {
					if status.Valid {
						col.Status = status.String
					}
					columns = append(columns, col)
				}
			}

			configBytes, _ := json.Marshal(columns)
			columnsConfig = string(configBytes)
		}

		templateID := generateID()
		now := time.Now()

		_, err := db.Exec(`
			INSERT INTO templates (id, name, board_id, columns_config, include_tasks, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, templateID, req.Name, req.BoardID, columnsConfig, req.IncludeTasks, user.ID, now, now)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save template"})
			return
		}

		LogActivity(db, user.ID, "TEMPLATE_CREATE", "TEMPLATE", templateID, req.Name, "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":            templateID,
			"name":          req.Name,
			"boardId":       req.BoardID,
			"columnsConfig": columnsConfig,
			"includeTasks":  req.IncludeTasks,
			"createdBy":     user.ID,
			"createdAt":     now,
			"updatedAt":     now,
		})
	}
}

func DeleteTemplate(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Template ID is required"})
			return
		}

		result, err := db.Exec("DELETE FROM templates WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete template"})
			return
		}

		rowsAffected, _ := result.RowsAffected()
		if rowsAffected == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Template not found"})
			return
		}

		LogActivity(db, user.ID, "TEMPLATE_DELETE", "TEMPLATE", id, "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
