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

func ImportBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req ImportBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid import data"})
			return
		}

		boardID := req.BoardID
		if boardID == "" {
			boardID = generateID()
		}

		boardName := req.Data.BoardName
		if boardName == "" {
			boardName = "Imported Board"
		}

		var boardExists bool
		if boardID != "" {
			err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM boards WHERE id = ? AND deleted = false)", boardID).Scan(&boardExists)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check board"})
				return
			}
		}

		if boardExists && !req.Reset {
			c.JSON(http.StatusConflict, gin.H{"error": "Board ID already exists, please confirm and retry to overwrite"})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}
		defer tx.Rollback()

		now := time.Now()
		if boardExists && req.Reset {
			if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to reset this board"})
				return
			}
			_, err = tx.Exec("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?", boardName, now, boardID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
				return
			}
			if err := resetBoardData(tx, boardID); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear board data"})
				return
			}
		} else {
			_, err = tx.Exec(
				"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				boardID, boardName, false, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
				return
			}
		}

		columnIDMap := make(map[string]string)

		for _, col := range req.Data.Columns {
			colID := generateID()
			columnIDMap[col.ID] = colID

			status := ""
			if col.Status != nil {
				status = *col.Status
			}

			color := col.Color
			if color == "" {
				color = "#6b7280"
			}

			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, status, col.Position, color, boardID, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
				return
			}
		}

		for _, col := range req.Data.Columns {
			newColID := columnIDMap[col.ID]

			for _, task := range col.Tasks {
				taskID := generateID()

				description := ""
				if task.Description != nil {
					description = *task.Description
				}

				assignee := ""
				if task.Assignee != nil {
					assignee = *task.Assignee
				}

				meta := ""
				if task.Meta != nil {
					meta = *task.Meta
				}

				priority := task.Priority
				if priority == "" {
					priority = "medium"
				}

				_, err = tx.Exec(
					"INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					taskID, task.Title, description, priority, assignee, meta, newColID, task.Position, task.Published, task.Archived, now, now,
				)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create task"})
					return
				}

				for _, comment := range task.Comments {
					commentID := generateID()
					_, err = tx.Exec(
						"INSERT INTO comments (id, content, author, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						commentID, comment.Content, comment.Author, taskID, now, now,
					)
					if err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create comment"})
						return
					}
				}

				for _, subtask := range task.Subtasks {
					subtaskID := generateID()
					_, err = tx.Exec(
						"INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						subtaskID, subtask.Title, subtask.Completed, taskID, now, now,
					)
					if err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create subtask"})
						return
					}
				}
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Import failed"})
			return
		}

		LogActivity(db, user.ID, "BOARD_IMPORT", "BOARD", boardID, boardName, "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":   boardID,
			"name": boardName,
		})
	}
}
