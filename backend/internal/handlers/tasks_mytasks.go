package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

func GetMyTasks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var tokenKey string
		if authHeader := c.GetHeader("Authorization"); authHeader != "" {
			if strings.HasPrefix(authHeader, "Bearer ") {
				tokenKey = strings.TrimPrefix(authHeader, "Bearer ")
			}
		}
		if tokenKey == "" {
			tokenKey, _ = c.Cookie("kanban-token")
		}

		var userAgent string
		err := db.QueryRow("SELECT user_agent FROM tokens WHERE `key` = ?", tokenKey).Scan(&userAgent)
		if err != nil {
			userAgent = ""
		}

		rows, err := db.Query(`
			SELECT c.id, c.name, c.board_id, COALESCE(ca.agent_types, '[]') as agent_types
			FROM columns c
			LEFT JOIN column_agents ca ON c.id = ca.column_id
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column info"})
			return
		}
		defer rows.Close()

		columnIDs := make(map[string]bool)
		for rows.Next() {
			var colID, colName, boardID, agentTypesStr string
			if err := rows.Scan(&colID, &colName, &boardID, &agentTypesStr); err == nil {
				if userAgent != "" && agentTypesStr != "" && agentTypesStr != "[]" {
					var agentTypes []string
					json.Unmarshal([]byte(agentTypesStr), &agentTypes)
					for _, at := range agentTypes {
						if at == userAgent {
							columnIDs[colID] = true
							break
						}
					}
				}
			}
		}

		var tasks []gin.H
		var taskRows *sql.Rows

		if userAgent != "" && len(columnIDs) > 0 {
			args := make([]interface{}, 0, len(columnIDs)+1)
			for colID := range columnIDs {
				args = append(args, colID)
			}
			args = append(args, user.Nickname)

			inClause := buildInClause(len(columnIDs))
			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name,
				       (SELECT COUNT(*) FROM comments WHERE task_id = t.id) as comment_count,
				       (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) as subtask_count
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND (t.assignee = ? OR t.column_id IN %s)
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, inClause)

			taskRows, err = db.Query(query, args...)
		} else if userAgent != "" {
			taskRows, err = db.Query(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name,
				       (SELECT COUNT(*) FROM comments WHERE task_id = t.id) as comment_count,
				       (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) as subtask_count
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.assignee = ?
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, user.Nickname)
		} else if len(columnIDs) > 0 {
			args := make([]interface{}, 0, len(columnIDs))
			for colID := range columnIDs {
				args = append(args, colID)
			}

			inClause := buildInClause(len(columnIDs))
			query := fmt.Sprintf(`
				SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
				       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
				       c.name as column_name,
				       (SELECT COUNT(*) FROM comments WHERE task_id = t.id) as comment_count,
				       (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) as subtask_count
				FROM tasks t
				JOIN columns c ON t.column_id = c.id
				WHERE t.archived = false AND t.published = true
				  AND t.column_id IN %s
				ORDER BY c.position ASC, t.position ASC, t.created_at ASC
			`, inClause)

			taskRows, err = db.Query(query, args...)
		} else {
			tasks = []gin.H{}
		}

		if err != nil && tasks == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get tasks"})
			return
		}

		if taskRows != nil {
			defer taskRows.Close()
			for taskRows.Next() {
				var task models.Task
				var desc, assignee, meta, createdBy, columnName, agentID, agentPrompt sql.NullString
				var archivedAt sql.NullTime
				var commentCount, subtaskCount int
				if err := taskRows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt, &columnName, &commentCount, &subtaskCount); err == nil {
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
					if agentID.Valid {
						task.AgentID = &agentID.String
					}
					if agentPrompt.Valid {
						task.AgentPrompt = &agentPrompt.String
					}
					if createdBy.Valid {
						task.CreatedBy = createdBy.String
					}

					tasks = append(tasks, gin.H{
						"id":          task.ID,
						"title":       task.Title,
						"description": task.Description,
						"priority":    task.Priority,
						"assignee":    task.Assignee,
						"meta":        task.Meta,
						"columnId":    task.ColumnID,
						"columnName":  columnName.String,
						"position":    task.Position,
						"published":   task.Published,
						"agentId":     task.AgentID,
						"agentPrompt": task.AgentPrompt,
						"archived":    task.Archived,
						"archivedAt":  task.ArchivedAt,
						"createdBy":   task.CreatedBy,
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

		c.JSON(http.StatusOK, gin.H{
			"tasks":     tasks,
			"total":     len(tasks),
			"userAgent": userAgent,
		})
	}
}
