package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

const (
	MaxFileSize       = 10 * 1024 * 1024 // 10MB
	UploadDir         = "./uploads"
	AllowedImageTypes = "image/jpeg,image/png,image/gif,image/webp"
	AllowedDocTypes   = "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
)

// isAllowedFileType checks if the file type is allowed
func isAllowedFileType(mimeType string) bool {
	allowedTypes := AllowedImageTypes + "," + AllowedDocTypes
	for _, t := range strings.Split(allowedTypes, ",") {
		if strings.TrimSpace(t) == mimeType {
			return true
		}
	}
	return false
}

// generateFileID generates a unique file ID with sufficient entropy
func generateFileID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "att_" + hex.EncodeToString(bytes)
}

// sanitizeFilename removes path traversal characters from filename
func sanitizeFilename(filename string) string {
	filename = filepath.Base(filename)
	filename = strings.ReplaceAll(filename, string(filepath.Separator), "")
	filename = strings.ReplaceAll(filename, "/", "")
	filename = strings.ReplaceAll(filename, "\\", "")
	filename = strings.ReplaceAll(filename, "..", "")
	if filename == "" || filename == "." {
		filename = "unnamed"
	}
	return filename
}

// UploadFile handles file upload (single or multiple)
func UploadFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot upload files"})
			return
		}

		if !checkRateLimit("upload:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			return
		}

		// Parse multipart form with max memory
		if err := c.Request.ParseMultipartForm(MaxFileSize * 10); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to parse form"})
			return
		}

		// Get optional parameters
		taskID := c.PostForm("taskId")
		commentID := c.PostForm("commentId")

		// Authorization check: verify user has access to the task/comment's board
		if taskID != "" {
			boardID, err := getBoardIDForTask(db, taskID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task ID"})
				return
			}
			if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to upload file to this task"})
				return
			}
		} else if commentID != "" {
			// Get task ID from comment
			var cTaskID string
			err := db.QueryRow("SELECT task_id FROM comments WHERE id = ?", commentID).Scan(&cTaskID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid comment ID"})
				return
			}
			boardID, err := getBoardIDForTask(db, cTaskID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid comment task association"})
				return
			}
			if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to upload file to this comment"})
				return
			}
		}

		// Get uploader ID from cookie/token (optional)
		var uploaderID *string
		if cookie, err := c.Cookie("kanban-token"); err == nil && cookie != "" {
			var userID string
			err := db.QueryRow("SELECT user_id FROM tokens WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", cookie, time.Now()).Scan(&userID)
			if err == nil {
				uploaderID = &userID
			}
		}

		// Check for multiple files first (key: "files")
		if files := c.Request.MultipartForm.File["files"]; len(files) > 0 {
			var uploadedFiles []gin.H

			for _, header := range files {
				// Check file size
				if header.Size > MaxFileSize {
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("File %s is too large, maximum supported size is 10MB", header.Filename)})
					return
				}

				file, err := header.Open()
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to read file %s", header.Filename)})
					return
				}

				// Detect content type
				buffer := make([]byte, 512)
				n, err := file.Read(buffer)
				if err != nil && err != io.EOF {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
					return
				}
				mimeType := http.DetectContentType(buffer[:n])

				// Check file type
				if !isAllowedFileType(mimeType) {
					file.Close()
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Unsupported file type: %s", header.Filename)})
					return
				}

				// Reset file reader
				file.Seek(0, 0)

				// Generate file ID and storage path
				fileID := generateFileID()
				safeFilename := sanitizeFilename(header.Filename)
				ext := filepath.Ext(safeFilename)
				if ext == "" {
					ext = ".bin"
				}
				storageName := fileID + ext
				storagePath := filepath.Join(UploadDir, storageName)

				// Create uploads directory if not exists
				if err := os.MkdirAll(UploadDir, 0755); err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create upload directory"})
					return
				}

				// Create destination file
				dst, err := os.Create(storagePath)
				if err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
					return
				}

				// Copy file content
				if _, err := io.Copy(dst, file); err != nil {
					dst.Close()
					file.Close()
					os.Remove(storagePath)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file"})
					return
				}

				dst.Close()
				file.Close()

				// Insert into database
				query := `
					INSERT INTO attachments (id, filename, storage_path, storage_type, mime_type, size, uploader_id, task_id, comment_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
				now := time.Now()
				_, err = db.Exec(query, fileID, header.Filename, storagePath, "local", mimeType, header.Size, uploaderID,
					func() *string {
						if taskID != "" {
							return &taskID
						}
						return nil
					}(),
					func() *string {
						if commentID != "" {
							return &commentID
						}
						return nil
					}(),
					now, now)

				if err != nil {
					os.Remove(storagePath)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save attachment record"})
					return
				}

				uploadedFiles = append(uploadedFiles, gin.H{
					"id":       fileID,
					"filename": header.Filename,
					"url":      fmt.Sprintf("/uploads/%s", fileID),
					"mimeType": mimeType,
					"size":     header.Size,
				})
			}

			c.JSON(http.StatusOK, gin.H{
				"files": uploadedFiles,
				"count": len(uploadedFiles),
			})
			return
		}

		// Single file upload (backward compatibility, key: "file")
		file, header, err := c.Request.FormFile("file")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "No upload file found"})
			return
		}
		defer file.Close()

		// Check file size
		if header.Size > MaxFileSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "File too large, maximum supported size is 10MB"})
			return
		}

		// Detect content type
		buffer := make([]byte, 512)
		n, err := file.Read(buffer)
		if err != nil && err != io.EOF {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
			return
		}
		mimeType := http.DetectContentType(buffer[:n])

		// Check file type
		if !isAllowedFileType(mimeType) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported file type"})
			return
		}

		// Reset file reader
		file.Seek(0, 0)

		// Generate file ID and storage path
		fileID := generateFileID()
		safeFilename := sanitizeFilename(header.Filename)
		ext := filepath.Ext(safeFilename)
		if ext == "" {
			ext = ".bin"
		}
		storageName := fileID + ext
		storagePath := filepath.Join(UploadDir, storageName)

		// Create uploads directory if not exists
		if err := os.MkdirAll(UploadDir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create upload directory"})
			return
		}

		// Create destination file
		dst, err := os.Create(storagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
			return
		}
		defer dst.Close()

		// Copy file content
		if _, err := io.Copy(dst, file); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file"})
			return
		}

		// Get optional parameters for single file upload (reuse variables)
		taskID = c.PostForm("taskId")
		commentID = c.PostForm("commentId")

		// Get uploader ID from cookie/token (optional) - reuse existing uploaderID variable
		if cookie, err := c.Cookie("kanban-token"); err == nil && cookie != "" {
			// Try to get user from token
			var userID string
			err := db.QueryRow("SELECT user_id FROM tokens WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", cookie, time.Now()).Scan(&userID)
			if err == nil {
				uploaderID = &userID
			}
		}

		// Insert into database
		query := `
			INSERT INTO attachments (id, filename, storage_path, storage_type, mime_type, size, uploader_id, task_id, comment_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`
		now := time.Now()
		_, err = db.Exec(query, fileID, header.Filename, storagePath, "local", mimeType, header.Size, uploaderID,
			func() *string {
				if taskID != "" {
					return &taskID
				}
				return nil
			}(),
			func() *string {
				if commentID != "" {
					return &commentID
				}
				return nil
			}(),
			now, now)

		if err != nil {
			// Rollback: delete saved file
			os.Remove(storagePath)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save attachment record"})
			return
		}

		// Return response
		c.JSON(http.StatusOK, gin.H{
			"id":       fileID,
			"filename": header.Filename,
			"url":      fmt.Sprintf("/uploads/%s", fileID),
			"mimeType": mimeType,
			"size":     header.Size,
		})
	}
}

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
