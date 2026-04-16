package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"open-kanban/internal/models"
	"open-kanban/internal/utils"

	"github.com/gin-gonic/gin"
)

// GetColumns returns columns for a board
func GetColumns(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)

		boardID := c.Query("boardId")

		// Get first board if none specified
		if boardID == "" {
			var firstBoardID string
			err := db.QueryRow(
				"SELECT id FROM boards WHERE deleted = false ORDER BY created_at ASC LIMIT 1",
			).Scan(&firstBoardID)
			if err == nil {
				boardID = firstBoardID
			}
		}

		// Verify board access (skip for public boards or unauthenticated users on public read)
		if boardID != "" && user != nil {
			if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this board"})
				return
			}
		}

		// Get columns
		var rows *sql.Rows
		var err error
		positionsParam := c.Query("positions")

		if boardID != "" && positionsParam != "" {
			positions := strings.Split(positionsParam, ",")
			args := make([]interface{}, 0, len(positions)+1)
			args = append(args, boardID)
			for _, p := range positions {
				pos, err := strconv.Atoi(strings.TrimSpace(p))
				if err != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid position value"})
					return
				}
				args = append(args, pos)
			}
			inClause := buildInClause(len(positions))
			query := fmt.Sprintf(
				"SELECT id, name, status, position, color, description, owner_agent_id, board_id, created_at, updated_at FROM columns WHERE board_id = ? AND position IN %s ORDER BY position ASC",
				inClause,
			)
			rows, err = db.Query(query, args...)
		} else if boardID != "" {
			// Only boardId specified
			rows, err = db.Query(
				"SELECT id, name, status, position, color, description, owner_agent_id, board_id, created_at, updated_at FROM columns WHERE board_id = ? ORDER BY position ASC",
				boardID,
			)
		} else if positionsParam != "" {
			positions := strings.Split(positionsParam, ",")
			args := make([]interface{}, len(positions))
			for i, p := range positions {
				pos, err := strconv.Atoi(strings.TrimSpace(p))
				if err != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid position value"})
					return
				}
				args[i] = pos
			}
			inClause := buildInClause(len(positions))
			query := fmt.Sprintf(
				"SELECT id, name, status, position, color, description, owner_agent_id, board_id, created_at, updated_at FROM columns WHERE position IN %s ORDER BY position ASC",
				inClause,
			)
			rows, err = db.Query(query, args...)
		} else {
			// No filters
			rows, err = db.Query(
				"SELECT id, name, status, position, color, description, owner_agent_id, board_id, created_at, updated_at FROM columns ORDER BY position ASC",
			)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column"})
			return
		}
		defer rows.Close()

		columns := []gin.H{}
		for rows.Next() {
			var col models.Column
			var status sql.NullString
			var description sql.NullString
			var ownerAgentId sql.NullString
			if err := rows.Scan(&col.ID, &col.Name, &status, &col.Position, &col.Color, &description, &ownerAgentId, &col.BoardID, &col.CreatedAt, &col.UpdatedAt); err == nil {
				if status.Valid {
					col.Status = &status.String
				}
				if description.Valid {
					col.Description = description.String
				}
				if ownerAgentId.Valid {
					col.OwnerAgentID = &ownerAgentId.String
				}

				tasks := []gin.H{}
				taskRows, err := db.Query(`
					SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position,
					       t.published, t.archived, t.archived_at, t.created_at, t.updated_at,
					       COALESCE(cc.cnt, 0) as comment_count,
					       COALESCE(sc.cnt, 0) as subtask_count
					FROM tasks t
					INNER JOIN columns c ON t.column_id = c.id AND c.board_id = ?
					LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
					LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
					WHERE t.column_id = ? AND t.archived = false AND t.published = true
					ORDER BY t.position ASC, t.created_at ASC
				`, col.BoardID, col.ID)
				if err == nil {
					defer taskRows.Close()
					rowCount := 0
					for taskRows.Next() {
						rowCount++
						var task models.Task
						var desc, assignee, meta sql.NullString
						var archivedAt sql.NullTime
						var commentCount, subtaskCount int
						scanErr := taskRows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
							&task.Published, &task.Archived, &archivedAt, &task.CreatedAt, &task.UpdatedAt,
							&commentCount, &subtaskCount)
						if scanErr == nil {
							if desc.Valid {
								task.Description = &desc.String
							}
							if assignee.Valid {
								task.Assignee = &assignee.String
							}
							if meta.Valid {
								task.Meta = &meta.String
							}
							if archivedAt.Valid {
								task.ArchivedAt = &archivedAt.Time
							}

							tasks = append(tasks, gin.H{
								"id":          task.ID,
								"title":       task.Title,
								"description": task.Description,
								"priority":    task.Priority,
								"assignee":    task.Assignee,
								"meta":        task.Meta,
								"columnId":    task.ColumnID,
								"position":    task.Position,
								"published":   task.Published,
								"archived":    task.Archived,
								"archivedAt":  task.ArchivedAt,
								"createdAt":   task.CreatedAt,
								"updatedAt":   task.UpdatedAt,
								"_count": gin.H{
									"comments": commentCount,
									"subtasks": subtaskCount,
								},
							})
						}
					}
				}

				var agentConfig *gin.H
				var agentTypesStr string
				err = db.QueryRow(
					"SELECT agent_types FROM column_agents WHERE column_id = ?",
					col.ID,
				).Scan(&agentTypesStr)
				if err == nil {
					var agentTypes []string
					json.Unmarshal([]byte(agentTypesStr), &agentTypes)
					agentConfig = &gin.H{
						"agentTypes": agentTypes,
					}
				}

				columns = append(columns, gin.H{
					"id":           col.ID,
					"name":         col.Name,
					"status":       col.Status,
					"position":     col.Position,
					"color":        col.Color,
					"description":  col.Description,
					"ownerAgentId": col.OwnerAgentID,
					"boardId":      col.BoardID,
					"createdAt":    col.CreatedAt,
					"updatedAt":    col.UpdatedAt,
					"tasks":        tasks,
					"agentConfig":  agentConfig,
				})
			}
		}

		c.JSON(http.StatusOK, columns)
	}
}

// GetColumnSlug returns a pinyin slug for a given name
func GetColumnSlug(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Query("name")
		if name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name parameter is required"})
			return
		}
		slug := utils.ToPinyinSlug(name)
		c.JSON(http.StatusOK, gin.H{"slug": slug})
	}
}

// CreateColumnRequest represents column creation request
type CreateColumnRequest struct {
	Name     string `json:"name" validate:"required,max=100"`
	Status   string `json:"status" validate:"omitempty,max=50"`
	Position int    `json:"position"`
	Color    string `json:"color" validate:"omitempty,max=20"`
	BoardID  string `json:"boardId" validate:"required"`
}

// CreateColumn creates a new column
func CreateColumn(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req CreateColumnRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		if !checkBoardAccess(db, user.ID, req.BoardID, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to create column in this board"})
			return
		}

		colID := generateColumnID(db, req.Name, req.BoardID)
		now := time.Now()
		position := req.Position
		if position == 0 {
			var maxPosition int
			err := db.QueryRow("SELECT COALESCE(MAX(position), -1) FROM columns WHERE board_id = ?", req.BoardID).Scan(&maxPosition)
			if err != nil {
				maxPosition = -1
			}
			position = maxPosition + 1
		}
		color := req.Color
		if color == "" {
			color = "#6b7280"
		}

		var status interface{}
		if req.Status != "" {
			status = req.Status
		} else {
			status = nil
		}

		_, err := db.Exec(
			"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			colID, req.Name, status, position, color, req.BoardID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
			return
		}

		LogActivity(db, user.ID, "COLUMN_CREATE", "COLUMN", colID, req.Name, "", c.ClientIP(), getRequestSource(c))

		broadcast()

		var responseStatus interface{}
		if req.Status != "" {
			responseStatus = req.Status
		}

		c.JSON(http.StatusOK, gin.H{
			"id":        colID,
			"name":      req.Name,
			"status":    responseStatus,
			"position":  position,
			"color":     color,
			"boardId":   req.BoardID,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}

// UpdateColumnRequest represents column update request
type UpdateColumnRequest struct {
	ID           string  `json:"id" validate:"required"`
	Name         string  `json:"name" validate:"omitempty,required,max=100"`
	Status       string  `json:"status" validate:"omitempty,max=50"`
	Position     *int    `json:"position"`
	Color        string  `json:"color" validate:"omitempty,max=20"`
	Description  string  `json:"description" validate:"omitempty,max=500"`
	OwnerAgentId *string `json:"ownerAgentId" validate:"omitempty,uuid"`
}

// UpdateColumn updates a column
func UpdateColumn(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req UpdateColumnRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		var exists bool
		err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM columns WHERE id = ?)", req.ID).Scan(&exists)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Query failed"})
			return
		}
		if !exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid column ID"})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, req.ID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this column"})
			return
		}

		var oldColumn struct {
			Name         string
			Status       *string
			Position     int
			Color        string
			Description  string
			OwnerAgentId *string
		}
		err = db.QueryRow("SELECT name, status, position, color, description, owner_agent_id FROM columns WHERE id = ?", req.ID).Scan(&oldColumn.Name, &oldColumn.Status, &oldColumn.Position, &oldColumn.Color, &oldColumn.Description, &oldColumn.OwnerAgentId)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Query failed"})
			return
		}

		var changes []string

		if req.Name != "" && req.Name != oldColumn.Name {
			changes = append(changes, fmt.Sprintf("Name: '%s' → '%s'", oldColumn.Name, req.Name))
		}
		if req.Status != "" {
			oldStatus := ""
			if oldColumn.Status != nil {
				oldStatus = *oldColumn.Status
			}
			if req.Status != oldStatus {
				changes = append(changes, fmt.Sprintf("Status: '%s' → '%s'", oldStatus, req.Status))
			}
		}
		if req.Position != nil && *req.Position != oldColumn.Position {
			changes = append(changes, fmt.Sprintf("Position: %d → %d", oldColumn.Position, *req.Position))
		}
		if req.Color != "" && req.Color != oldColumn.Color {
			changes = append(changes, fmt.Sprintf("Color: '%s' → '%s'", oldColumn.Color, req.Color))
		}
		if req.Description != "" && req.Description != oldColumn.Description {
			changes = append(changes, fmt.Sprintf("Description: '%s' → '%s'", oldColumn.Description, req.Description))
		}
		if req.OwnerAgentId != nil {
			oldOwnerAgentId := ""
			if oldColumn.OwnerAgentId != nil {
				oldOwnerAgentId = *oldColumn.OwnerAgentId
			}
			if *req.OwnerAgentId != oldOwnerAgentId {
				changes = append(changes, fmt.Sprintf("Owner: '%s' → '%s'", oldOwnerAgentId, *req.OwnerAgentId))
			}
		}

		updates := []interface{}{time.Now()}
		query := "UPDATE columns SET updated_at = ?"

		if req.Name != "" {
			query += ", name = ?"
			updates = append(updates, req.Name)
		}
		if req.Status != "" {
			query += ", status = ?"
			updates = append(updates, req.Status)
		}
		if req.Position != nil {
			query += ", position = ?"
			updates = append(updates, *req.Position)
		}
		if req.Color != "" {
			query += ", color = ?"
			updates = append(updates, req.Color)
		}
		if req.Description != "" {
			query += ", description = ?"
			updates = append(updates, req.Description)
		}
		if req.OwnerAgentId != nil {
			query += ", owner_agent_id = ?"
			updates = append(updates, *req.OwnerAgentId)
		}

		query += " WHERE id = ?"
		updates = append(updates, req.ID)

		_, err = db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		details := ""
		if len(changes) > 0 {
			details = strings.Join(changes, ", ")
		}

		LogActivity(db, user.ID, "COLUMN_UPDATE", "COLUMN", req.ID, req.Name, details, c.ClientIP(), getRequestSource(c))

		broadcast()

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// DeleteColumn deletes a column
func DeleteColumn(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Query("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Column ID is required"})
			return
		}

		var exists bool
		db.QueryRow("SELECT EXISTS(SELECT 1 FROM columns WHERE id = ?)", id).Scan(&exists)
		if !exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid column ID"})
			return
		}

		if !checkColumnAccessWithBoardFallback(db, user.ID, id, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this column"})
			return
		}

		_, err := db.Exec("DELETE FROM columns WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		LogActivity(db, user.ID, "COLUMN_DELETE", "COLUMN", id, "", "", c.ClientIP(), getRequestSource(c))

		broadcast()

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// GetColumnAgent returns agent config for a column
func GetColumnAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		columnID := c.Param("columnId")
		if columnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Column ID is required"})
			return
		}

		var agentTypesStr string
		err := db.QueryRow(
			"SELECT agent_types FROM column_agents WHERE column_id = ?",
			columnID,
		).Scan(&agentTypesStr)

		if err != nil {
			c.JSON(http.StatusOK, gin.H{"agentTypes": []string{}})
			return
		}

		var agentTypes []string
		json.Unmarshal([]byte(agentTypesStr), &agentTypes)

		c.JSON(http.StatusOK, gin.H{"agentTypes": agentTypes})
	}
}

// SetColumnAgentRequest represents agent config request
type SetColumnAgentRequest struct {
	AgentTypes []string `json:"agentTypes"`
}

// ReorderColumnsRequest represents column reorder request
type ReorderColumnsRequest struct {
	BoardID string                     `json:"boardId"`
	Columns []ReorderColumnItemRequest `json:"columns"`
}

type ReorderColumnItemRequest struct {
	ID       string `json:"id"`
	Position int    `json:"position"`
}

// ReorderColumns updates the position of columns
func ReorderColumns(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req ReorderColumnsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		if req.BoardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, req.BoardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this board"})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
		defer tx.Rollback()

		now := time.Now()
		for _, col := range req.Columns {
			_, err := tx.Exec(
				"UPDATE columns SET position = ?, updated_at = ? WHERE id = ? AND board_id = ?",
				col.Position, now, col.ID, req.BoardID,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update column order"})
				return
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save order"})
			return
		}

		broadcast()

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// SetColumnAgent sets agent config for a column
func SetColumnAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can configure"})
			return
		}

		columnID := c.Param("columnId")
		if columnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Column ID is required"})
			return
		}

		var req SetColumnAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid parameters"})
			return
		}

		agentTypesJSON, _ := json.Marshal(req.AgentTypes)
		now := time.Now()

		// Try to update first, then insert
		res, err := db.Exec(
			"UPDATE column_agents SET agent_types = ?, updated_at = ? WHERE column_id = ?",
			string(agentTypesJSON), now, columnID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set"})
			return
		}

		rowsAffected, _ := res.RowsAffected()
		if rowsAffected == 0 {
			// Insert new
			agentID := generateID()
			_, err = db.Exec(
				"INSERT INTO column_agents (id, column_id, agent_types, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				agentID, columnID, string(agentTypesJSON), now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set"})
				return
			}
		}

		c.JSON(http.StatusOK, gin.H{"agentTypes": req.AgentTypes})
	}
}

// DeleteColumnAgent deletes agent config for a column
func DeleteColumnAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can configure"})
			return
		}

		columnID := c.Param("columnId")
		if columnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Column ID is required"})
			return
		}

		_, err := db.Exec("DELETE FROM column_agents WHERE column_id = ?", columnID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func generateColumnID(db *sql.DB, name string, boardID string) string {
	baseSlug := utils.ToPinyinSlug(name)
	if baseSlug == "" {
		baseSlug = "column"
	}

	colID := baseSlug
	counter := 1
	for {
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM columns WHERE id = ? AND board_id = ?", colID, boardID).Scan(&count)
		if err != nil {
			break
		}
		if count == 0 {
			return colID
		}
		colID = fmt.Sprintf("%s-%d", baseSlug, counter)
		counter++
	}
	return colID
}

// Helper function to get comments for a task
func getCommentsForTask(db *sql.DB, taskID string) ([]gin.H, error) {
	rows, err := db.Query(
		"SELECT id, content, author, task_id, created_at, updated_at FROM comments WHERE task_id = ? ORDER BY created_at DESC",
		taskID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var comments []gin.H
	for rows.Next() {
		var c models.Comment
		if err := rows.Scan(&c.ID, &c.Content, &c.Author, &c.TaskID, &c.CreatedAt, &c.UpdatedAt); err == nil {
			comments = append(comments, gin.H{
				"id":        c.ID,
				"content":   c.Content,
				"author":    c.Author,
				"taskId":    c.TaskID,
				"createdAt": c.CreatedAt,
				"updatedAt": c.UpdatedAt,
			})
		}
	}
	return comments, nil
}

// Helper function to get subtasks for a task
func getSubtasksForTask(db *sql.DB, taskID string) ([]gin.H, error) {
	rows, err := db.Query(
		"SELECT id, title, completed, task_id, created_at, updated_at FROM subtasks WHERE task_id = ? ORDER BY created_at ASC",
		taskID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subtasks []gin.H
	for rows.Next() {
		var s models.Subtask
		if err := rows.Scan(&s.ID, &s.Title, &s.Completed, &s.TaskID, &s.CreatedAt, &s.UpdatedAt); err == nil {
			subtasks = append(subtasks, gin.H{
				"id":        s.ID,
				"title":     s.Title,
				"completed": s.Completed,
				"taskId":    s.TaskID,
				"createdAt": s.CreatedAt,
				"updatedAt": s.UpdatedAt,
			})
		}
	}
	return subtasks, nil
}

func buildInClause(n int) string {
	if n <= 0 {
		return "(NULL)"
	}
	return "(" + strings.Repeat("?,", n-1) + "?)"
}
