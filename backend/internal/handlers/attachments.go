package handlers

import (
	"database/sql"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

// ServeFile serves uploaded files
func ServeFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		fileID := c.Param("id")

		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var storagePath, mimeType, taskID string
		var commentID sql.NullString
		err := db.QueryRow("SELECT storage_path, mime_type, task_id, comment_id FROM attachments WHERE id = ?", fileID).Scan(&storagePath, &mimeType, &taskID, &commentID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
			return
		}

		if taskID != "" {
			boardID, err := getBoardIDForTask(db, taskID)
			if err == nil && !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this file"})
				return
			}
		} else if commentID.Valid {
			var cTaskID string
			err := db.QueryRow("SELECT task_id FROM comments WHERE id = ?", commentID.String).Scan(&cTaskID)
			if err == nil {
				boardID, err := getBoardIDForTask(db, cTaskID)
				if err == nil && !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
					c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this file"})
					return
				}
			}
		}

		absUploadDir, err := filepath.Abs(UploadDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}
		absFilePath, err := filepath.Abs(storagePath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid file path"})
			return
		}
		if !strings.HasPrefix(absFilePath, absUploadDir+string(filepath.Separator)) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this file is forbidden"})
			return
		}

		if _, err := os.Stat(absFilePath); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
			return
		}

		// Open file
		file, err := os.Open(absFilePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Cannot read file"})
			return
		}
		defer file.Close()

		// Get file size
		fileInfo, err := file.Stat()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Cannot get file info"})
			return
		}

		// Set content type - use stored mimeType if available, otherwise detect from extension
		contentType := mimeType
		if contentType == "" {
			contentType = mime.TypeByExtension(filepath.Ext(storagePath))
			if contentType == "" {
				contentType = "application/octet-stream"
			}
		}

		// Use DataFromReader to properly set Content-Type header before sending file content
		c.DataFromReader(http.StatusOK, fileInfo.Size(), contentType, file, nil)
	}
}

// DeleteAttachment deletes an attachment
func DeleteAttachment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot delete attachments"})
			return
		}

		fileID := c.Param("id")

		var taskID, storagePath string
		var commentID sql.NullString
		err := db.QueryRow("SELECT task_id, comment_id, storage_path FROM attachments WHERE id = ?", fileID).Scan(&taskID, &commentID, &storagePath)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Attachment not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query attachments"})
			return
		}

		if taskID != "" {
			boardID, err := getBoardIDForTask(db, taskID)
			if err == nil && !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this attachment"})
				return
			}
		}

		if commentID.Valid && taskID == "" {
			var cTaskID string
			err := db.QueryRow("SELECT task_id FROM comments WHERE id = ?", commentID.String).Scan(&cTaskID)
			if err == nil {
				boardID, err := getBoardIDForTask(db, cTaskID)
				if err == nil && !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
					c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this attachment"})
					return
				}
			}
		}

		// Delete from database
		result, err := db.Exec("DELETE FROM attachments WHERE id = ?", fileID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete attachment record"})
			return
		}

		rowsAffected, _ := result.RowsAffected()
		if rowsAffected == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Attachment not found"})
			return
		}

		// Security: Validate storage path is within upload directory to prevent path traversal
		absUploadDir, err := filepath.Abs(UploadDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}
		absFilePath, err := filepath.Abs(storagePath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid file path"})
			return
		}
		if !strings.HasPrefix(absFilePath, absUploadDir+string(filepath.Separator)) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this file is forbidden"})
			return
		}

		// Delete physical file
		if err := os.Remove(absFilePath); err != nil && !os.IsNotExist(err) {
			// Log error but don't fail the request
			fmt.Printf("Failed to delete file %s: %v\n", absFilePath, err)
		}

		c.Status(http.StatusNoContent)
	}
}

// GetTaskAttachments gets all attachments for a task
func GetTaskAttachments(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		taskID := c.Param("taskId")

		query := `
			SELECT id, filename, storage_path, storage_type, mime_type, size, uploader_id, task_id, comment_id, created_at, updated_at
			FROM attachments
			WHERE task_id = ?
			ORDER BY created_at DESC
		`

		rows, err := db.Query(query, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query attachments"})
			return
		}
		defer rows.Close()

		var attachments []models.Attachment
		for rows.Next() {
			var att models.Attachment
			var mimeType sql.NullString
			var uploaderID, taskID_, commentID sql.NullString

			err := rows.Scan(
				&att.ID, &att.Filename, &att.StoragePath, &att.StorageType,
				&mimeType, &att.Size, &uploaderID, &taskID_, &commentID,
				&att.CreatedAt, &att.UpdatedAt,
			)
			if err != nil {
				continue
			}

			if mimeType.Valid {
				att.MimeType = &mimeType.String
			}
			if uploaderID.Valid {
				att.UploaderID = &uploaderID.String
			}
			if taskID_.Valid {
				att.TaskID = &taskID_.String
			}
			if commentID.Valid {
				att.CommentID = &commentID.String
			}

			attachments = append(attachments, att)
		}

		c.JSON(http.StatusOK, attachments)
	}
}
