package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

const (
	MaxFileSize    = 10 * 1024 * 1024 // 10MB
	UploadDir      = "./uploads"
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

// generateFileID generates a unique file ID
func generateFileID() string {
	bytes := make([]byte, 4)
	rand.Read(bytes)
	return "att_" + hex.EncodeToString(bytes)
}

// UploadFile handles file upload (single or multiple)
func UploadFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Parse multipart form with max memory
		if err := c.Request.ParseMultipartForm(MaxFileSize * 10); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "表单解析失败"})
			return
		}

		// Get optional parameters
		taskID := c.PostForm("taskId")
		commentID := c.PostForm("commentId")

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
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("文件 %s 过大，最大支持10MB", header.Filename)})
					return
				}

				file, err := header.Open()
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("读取文件 %s 失败", header.Filename)})
					return
				}

				// Detect content type
				buffer := make([]byte, 512)
				n, err := file.Read(buffer)
				if err != nil && err != io.EOF {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "读取文件失败"})
					return
				}
				mimeType := http.DetectContentType(buffer[:n])

				// Check file type
				if !isAllowedFileType(mimeType) {
					file.Close()
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("不支持的文件类型: %s", header.Filename)})
					return
				}

				// Reset file reader
				file.Seek(0, 0)

				// Generate file ID and storage path
				fileID := generateFileID()
				ext := filepath.Ext(header.Filename)
				storageName := fileID + ext
				storagePath := filepath.Join(UploadDir, storageName)

				// Create uploads directory if not exists
				if err := os.MkdirAll(UploadDir, 0755); err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "创建上传目录失败"})
					return
				}

				// Create destination file
				dst, err := os.Create(storagePath)
				if err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "创建文件失败"})
					return
				}

				// Copy file content
				if _, err := io.Copy(dst, file); err != nil {
					dst.Close()
					file.Close()
					os.Remove(storagePath)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "保存文件失败"})
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
					func() *string { if taskID != "" { return &taskID }; return nil }(),
					func() *string { if commentID != "" { return &commentID }; return nil }(),
					now, now)

				if err != nil {
					os.Remove(storagePath)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "保存附件记录失败"})
					return
				}

				uploadedFiles = append(uploadedFiles, gin.H{
					"id":       fileID,
					"filename": header.Filename,
					"url":      fmt.Sprintf("/api/uploads/%s", fileID),
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "未找到上传文件"})
			return
		}
		defer file.Close()

		// Check file size
		if header.Size > MaxFileSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "文件过大，最大支持10MB"})
			return
		}

		// Detect content type
		buffer := make([]byte, 512)
		n, err := file.Read(buffer)
		if err != nil && err != io.EOF {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取文件失败"})
			return
		}
		mimeType := http.DetectContentType(buffer[:n])

		// Check file type
		if !isAllowedFileType(mimeType) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的文件类型"})
			return
		}

		// Reset file reader
		file.Seek(0, 0)

		// Generate file ID and storage path
		fileID := generateFileID()
		ext := filepath.Ext(header.Filename)
		storageName := fileID + ext
		storagePath := filepath.Join(UploadDir, storageName)

		// Create uploads directory if not exists
		if err := os.MkdirAll(UploadDir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建上传目录失败"})
			return
		}

		// Create destination file
		dst, err := os.Create(storagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建文件失败"})
			return
		}
		defer dst.Close()

		// Copy file content
		if _, err := io.Copy(dst, file); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存文件失败"})
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
			func() *string { if taskID != "" { return &taskID }; return nil }(),
			func() *string { if commentID != "" { return &commentID }; return nil }(),
			now, now)

		if err != nil {
			// Rollback: delete saved file
			os.Remove(storagePath)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存附件记录失败"})
			return
		}

		// Return response
		c.JSON(http.StatusOK, gin.H{
			"id":       fileID,
			"filename": header.Filename,
			"url":      fmt.Sprintf("/api/uploads/%s", fileID),
			"mimeType": mimeType,
			"size":     header.Size,
		})
	}
}

// ServeFile serves uploaded files
func ServeFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		fileID := c.Param("id")

		// Query database for file info
		var storagePath, mimeType string
		err := db.QueryRow("SELECT storage_path, mime_type FROM attachments WHERE id = ?", fileID).Scan(&storagePath, &mimeType)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询文件失败"})
			return
		}

		// Check if file exists
		if _, err := os.Stat(storagePath); os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
			return
		}

		// Set content type if available
		if mimeType != "" {
			c.Header("Content-Type", mimeType)
		}

		// Serve file
		c.File(storagePath)
	}
}

// DeleteAttachment deletes an attachment
func DeleteAttachment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		fileID := c.Param("id")

		// Get file path before deleting record
		var storagePath string
		err := db.QueryRow("SELECT storage_path FROM attachments WHERE id = ?", fileID).Scan(&storagePath)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "附件不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询附件失败"})
			return
		}

		// Delete from database
		result, err := db.Exec("DELETE FROM attachments WHERE id = ?", fileID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除附件记录失败"})
			return
		}

		rowsAffected, _ := result.RowsAffected()
		if rowsAffected == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "附件不存在"})
			return
		}

		// Delete physical file
		if err := os.Remove(storagePath); err != nil && !os.IsNotExist(err) {
			// Log error but don't fail the request
			fmt.Printf("Failed to delete file %s: %v\n", storagePath, err)
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询附件失败"})
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
