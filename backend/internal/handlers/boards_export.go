package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func ExportBoard(db *sql.DB) gin.HandlerFunc {
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

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this board"})
			return
		}

		format := c.Query("format")
		if format == "" {
			format = "json"
		}

		if format != "json" && format != "csv" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported export format, only json and csv are supported"})
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

		exportData := gin.H{
			"boardId":    boardID,
			"boardName":  boardName,
			"exportedAt": time.Now(),
			"columns":    []gin.H{},
		}

		colRows, err := db.Query(`
			SELECT id, name, status, position, color, board_id, created_at, updated_at
			FROM columns WHERE board_id = ? ORDER BY position ASC
		`, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column"})
			return
		}
		defer colRows.Close()

		var columns []gin.H
		for colRows.Next() {
			var col struct {
				ID        string
				Name      string
				Status    sql.NullString
				Position  int
				Color     string
				BoardID   string
				CreatedAt time.Time
				UpdatedAt time.Time
			}
			if err := colRows.Scan(&col.ID, &col.Name, &col.Status, &col.Position, &col.Color, &col.BoardID, &col.CreatedAt, &col.UpdatedAt); err != nil {
				continue
			}

			var statusVal *string
			if col.Status.Valid {
				statusVal = &col.Status.String
			}

			taskRows, err := db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks WHERE column_id = ? ORDER BY position ASC
			`, col.ID)
			if err != nil {
				continue
			}

			var tasks []gin.H
			for taskRows.Next() {
				var task struct {
					ID          string
					Title       string
					Description sql.NullString
					Priority    string
					Assignee    sql.NullString
					Meta        sql.NullString
					ColumnID    string
					Position    int
					Published   bool
					Archived    bool
					ArchivedAt  sql.NullTime
					CreatedAt   time.Time
					UpdatedAt   time.Time
				}
				if err := taskRows.Scan(&task.ID, &task.Title, &task.Description, &task.Priority, &task.Assignee, &task.Meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &task.ArchivedAt, &task.CreatedAt, &task.UpdatedAt); err != nil {
					continue
				}

				var descVal, assigneeVal, metaVal *string
				if task.Description.Valid {
					descVal = &task.Description.String
				}
				if task.Assignee.Valid {
					assigneeVal = &task.Assignee.String
				}
				if task.Meta.Valid {
					metaVal = &task.Meta.String
				}

				comments, _ := getCommentsForTask(db, task.ID)
				subtasks, _ := getSubtasksForTask(db, task.ID)

				tasks = append(tasks, gin.H{
					"id":          task.ID,
					"title":       task.Title,
					"description": descVal,
					"priority":    task.Priority,
					"assignee":    assigneeVal,
					"meta":        metaVal,
					"columnId":    task.ColumnID,
					"position":    task.Position,
					"published":   task.Published,
					"archived":    task.Archived,
					"archivedAt":  task.ArchivedAt.Time,
					"createdAt":   task.CreatedAt,
					"updatedAt":   task.UpdatedAt,
					"comments":    comments,
					"subtasks":    subtasks,
				})
			}
			taskRows.Close()

			columns = append(columns, gin.H{
				"id":        col.ID,
				"name":      col.Name,
				"status":    statusVal,
				"position":  col.Position,
				"color":     col.Color,
				"boardId":   col.BoardID,
				"createdAt": col.CreatedAt,
				"updatedAt": col.UpdatedAt,
				"tasks":     tasks,
			})
		}
		exportData["columns"] = columns

		if format == "json" {
			c.JSON(http.StatusOK, exportData)
		} else {
			csv := generateCSV(exportData)
			timestamp := time.Now().Format("20060102_150405")
			filename := fmt.Sprintf("%s_%s.csv", boardName, timestamp)
			c.Header("Content-Description", "File Transfer")
			c.Header("Content-Disposition", "attachment; filename="+filename)
			c.Data(http.StatusOK, "text/csv; charset=utf-8", []byte(csv))
		}
	}
}
