package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

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
