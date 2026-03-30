package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
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
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

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

		// Verify board access
		if boardID != "" {
			if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "无权访问该看板"})
				return
			}
		}

		// Get columns
		var rows *sql.Rows
		var err error
		if boardID != "" {
			rows, err = db.Query(
				"SELECT id, name, status, position, color, board_id, created_at, updated_at FROM columns WHERE board_id = ? ORDER BY position ASC",
				boardID,
			)
		} else {
			rows, err = db.Query(
				"SELECT id, name, status, position, color, board_id, created_at, updated_at FROM columns ORDER BY position ASC",
			)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取列失败"})
			return
		}
		defer rows.Close()

		var columns []gin.H
		for rows.Next() {
			var col models.Column
			var status sql.NullString
			if err := rows.Scan(&col.ID, &col.Name, &status, &col.Position, &col.Color, &col.BoardID, &col.CreatedAt, &col.UpdatedAt); err == nil {
				if status.Valid {
					col.Status = &status.String
				}

				// Get tasks for this column
				var tasks []gin.H
				taskRows, err := db.Query(`
					SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
					FROM tasks
					WHERE column_id = ? AND archived = false AND published = true
					ORDER BY position ASC, created_at ASC
				`, col.ID)
				if err == nil {
					defer taskRows.Close()
					for taskRows.Next() {
						var task models.Task
						var desc, assignee, meta sql.NullString
						var archivedAt sql.NullTime
						if err := taskRows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &task.CreatedAt, &task.UpdatedAt); err == nil {
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

							// Get comments
							comments, _ := getCommentsForTask(db, task.ID)
							// Get subtasks
							subtasks, _ := getSubtasksForTask(db, task.ID)

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
								"comments":    comments,
								"subtasks":    subtasks,
							})
						}
					}
				}

				// Get agent config
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
					"id":          col.ID,
					"name":        col.Name,
					"status":      col.Status,
					"position":    col.Position,
					"color":       col.Color,
					"boardId":     col.BoardID,
					"createdAt":   col.CreatedAt,
					"updatedAt":   col.UpdatedAt,
					"tasks":       tasks,
					"agentConfig": agentConfig,
				})
			}
		}

		c.JSON(http.StatusOK, columns)
	}
}

// CreateColumnRequest represents column creation request
type CreateColumnRequest struct {
	Name     string `json:"name"`
	Status   string `json:"status"`
	Position int    `json:"position"`
	Color    string `json:"color"`
	BoardID  string `json:"boardId"`
}

// CreateColumn creates a new column
func CreateColumn(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		var req CreateColumnRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列名称不能为空"})
			return
		}

		if req.BoardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "看板 ID 不能为空"})
			return
		}

		if !checkBoardAccess(db, user.ID, req.BoardID, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权在该看板创建列"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建列失败"})
			return
		}

		LogActivity(db, user.ID, "COLUMN_CREATE", "COLUMN", colID, req.Name, "", c.ClientIP(), getRequestSource(c))

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":        colID,
			"name":      req.Name,
			"status":    req.Status,
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
	ID       string `json:"id"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Position int    `json:"position"`
	Color    string `json:"color"`
}

// UpdateColumn updates a column
func UpdateColumn(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		var req UpdateColumnRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		if req.ID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForColumn(db, req.ID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的列 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权修改该列"})
			return
		}

		var oldColumn struct {
			Name     string
			Status   *string
			Position int
			Color    string
		}
		db.QueryRow("SELECT name, status, position, color FROM columns WHERE id = ?", req.ID).Scan(&oldColumn.Name, &oldColumn.Status, &oldColumn.Position, &oldColumn.Color)

		var changes []string

		if req.Name != "" && req.Name != oldColumn.Name {
			changes = append(changes, fmt.Sprintf("名称: '%s' → '%s'", oldColumn.Name, req.Name))
		}
		if req.Status != "" {
			oldStatus := ""
			if oldColumn.Status != nil {
				oldStatus = *oldColumn.Status
			}
			if req.Status != oldStatus {
				changes = append(changes, fmt.Sprintf("状态: '%s' → '%s'", oldStatus, req.Status))
			}
		}
		if req.Position >= 0 && req.Position != oldColumn.Position {
			changes = append(changes, fmt.Sprintf("位置: %d → %d", oldColumn.Position, req.Position))
		}
		if req.Color != "" && req.Color != oldColumn.Color {
			changes = append(changes, fmt.Sprintf("颜色: '%s' → '%s'", oldColumn.Color, req.Color))
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
		if req.Position >= 0 {
			query += ", position = ?"
			updates = append(updates, req.Position)
		}
		if req.Color != "" {
			query += ", color = ?"
			updates = append(updates, req.Color)
		}

		query += " WHERE id = ?"
		updates = append(updates, req.ID)

		_, err = db.Exec(query, updates...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
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
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		id := c.Query("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForColumn(db, id)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的列 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权删除该列"})
			return
		}

		_, err = db.Exec("DELETE FROM columns WHERE id = ?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
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

// SetColumnAgent sets agent config for a column
func SetColumnAgent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以配置"})
			return
		}

		columnID := c.Param("columnId")
		if columnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
			return
		}

		var req SetColumnAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "设置失败"})
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
				c.JSON(http.StatusInternalServerError, gin.H{"error": "设置失败"})
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
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{"error": "只有管理员可以配置"})
			return
		}

		columnID := c.Param("columnId")
		if columnID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "列 ID 不能为空"})
			return
		}

		_, err := db.Exec("DELETE FROM column_agents WHERE column_id = ?", columnID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
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
