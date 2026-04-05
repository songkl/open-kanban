package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func CopyBoard(db *sql.DB) gin.HandlerFunc {
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

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy board"})
			return
		}
		defer tx.Rollback()

		newBoardID := generateID()
		now := time.Now()

		_, err = tx.Exec(
			"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			newBoardID, boardName+" (副本)", false, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy board"})
			return
		}

		colRows, err := tx.Query(`
			SELECT id, name, status, position, color, board_id, created_at, updated_at
			FROM columns WHERE board_id = ? ORDER BY position ASC
		`, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get columns"})
			return
		}

		oldToNewColIDs := make(map[string]string)

		for colRows.Next() {
			var colID, name, boardIDStr string
			var status sql.NullString
			var position int
			var color string
			var createdAt, updatedAt time.Time

			if err := colRows.Scan(&colID, &name, &status, &position, &color, &boardIDStr, &createdAt, &updatedAt); err != nil {
				colRows.Close()
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy column"})
				return
			}

			newColID := generateID()
			oldToNewColIDs[colID] = newColID

			var statusVal *string
			if status.Valid {
				statusVal = &status.String
			}

			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				newColID, name, statusVal, position, color, newBoardID, now, now,
			)
			if err != nil {
				colRows.Close()
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy column"})
				return
			}
		}
		colRows.Close()

		for oldColID, newColID := range oldToNewColIDs {
			taskRows, err := tx.Query(`
				SELECT id, title, description, priority, assignee, meta, position, published, archived, archived_at, created_by, created_at, updated_at
				FROM tasks WHERE column_id = ?
			`, oldColID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get tasks"})
				return
			}

			oldToNewTaskIDs := make(map[string]string)
			for taskRows.Next() {
				var taskID, title, createdBy string
				var description, assignee, meta sql.NullString
				var priority string
				var position int
				var published, archived bool
				var archivedAt sql.NullTime
				var createdAt, updatedAt time.Time

				if err := taskRows.Scan(&taskID, &title, &description, &priority, &assignee, &meta, &position, &published, &archived, &archivedAt, &createdBy, &createdAt, &updatedAt); err != nil {
					taskRows.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy task"})
					return
				}

				newTaskID := generateID()
				oldToNewTaskIDs[taskID] = newTaskID

				var descVal, assigneeVal, metaVal *string
				if description.Valid {
					descVal = &description.String
				}
				if assignee.Valid {
					assigneeVal = &assignee.String
				}
				if meta.Valid {
					metaVal = &meta.String
				}

				_, err = tx.Exec(`
					INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`, newTaskID, title, descVal, priority, assigneeVal, metaVal, newColID, position, published, archived, archivedAt, createdBy, createdAt, updatedAt)
				if err != nil {
					taskRows.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy task"})
					return
				}
			}
			taskRows.Close()

			for oldTaskID, newTaskID := range oldToNewTaskIDs {
				commentRows, err := tx.Query(`
					SELECT id, content, author, created_at, updated_at
					FROM comments WHERE task_id = ?
				`, oldTaskID)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get comments"})
					return
				}

				for commentRows.Next() {
					var commentID, content, author string
					var createdAt, updatedAt time.Time

					if err := commentRows.Scan(&commentID, &content, &author, &createdAt, &updatedAt); err != nil {
						commentRows.Close()
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy comment"})
						return
					}

					newCommentID := generateID()
					_, err = tx.Exec(`
						INSERT INTO comments (id, content, author, task_id, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?)
					`, newCommentID, content, author, newTaskID, createdAt, updatedAt)
					if err != nil {
						commentRows.Close()
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy comment"})
						return
					}
				}
				commentRows.Close()

				subtaskRows, err := tx.Query(`
					SELECT id, title, completed, created_at, updated_at
					FROM subtasks WHERE task_id = ?
				`, oldTaskID)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get subtasks"})
					return
				}

				for subtaskRows.Next() {
					var subtaskID, title string
					var completed bool
					var createdAt, updatedAt time.Time

					if err := subtaskRows.Scan(&subtaskID, &title, &completed, &createdAt, &updatedAt); err != nil {
						subtaskRows.Close()
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy subtask"})
						return
					}

					newSubtaskID := generateID()
					_, err = tx.Exec(`
						INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?)
					`, newSubtaskID, title, completed, newTaskID, createdAt, updatedAt)
					if err != nil {
						subtaskRows.Close()
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy subtask"})
						return
					}
				}
				subtaskRows.Close()
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_COPY", "BOARD", newBoardID, boardName+" (副本)", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":        newBoardID,
			"name":      boardName + " (副本)",
			"createdAt": now,
			"updatedAt": now,
		})
	}
}
