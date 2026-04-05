package handlers

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

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

		if err := c.Request.ParseMultipartForm(MaxFileSize * 10); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to parse form"})
			return
		}

		taskID := c.PostForm("taskId")
		commentID := c.PostForm("commentId")

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

		var uploaderID *string
		if cookie, err := c.Cookie("kanban-token"); err == nil && cookie != "" {
			var userID string
			err := db.QueryRow("SELECT user_id FROM tokens WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", cookie, time.Now()).Scan(&userID)
			if err == nil {
				uploaderID = &userID
			}
		}

		if files := c.Request.MultipartForm.File["files"]; len(files) > 0 {
			var uploadedFiles []gin.H

			for _, header := range files {
				if header.Size > MaxFileSize {
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("File %s is too large, maximum supported size is 10MB", header.Filename)})
					return
				}

				file, err := header.Open()
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to read file %s", header.Filename)})
					return
				}

				buffer := make([]byte, 512)
				n, err := file.Read(buffer)
				if err != nil && err != io.EOF {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
					return
				}
				mimeType := http.DetectContentType(buffer[:n])

				if !isAllowedFileType(mimeType) {
					file.Close()
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Unsupported file type: %s", header.Filename)})
					return
				}

				file.Seek(0, 0)

				fileID := generateFileID()
				safeFilename := sanitizeFilename(header.Filename)
				ext := filepath.Ext(safeFilename)
				if ext == "" {
					ext = ".bin"
				}
				storageName := fileID + ext
				storagePath := filepath.Join(UploadDir, storageName)

				if err := os.MkdirAll(UploadDir, 0755); err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create upload directory"})
					return
				}

				dst, err := os.Create(storagePath)
				if err != nil {
					file.Close()
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
					return
				}

				if _, err := io.Copy(dst, file); err != nil {
					dst.Close()
					file.Close()
					os.Remove(storagePath)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file"})
					return
				}

				dst.Close()
				file.Close()

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

		file, header, err := c.Request.FormFile("file")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "No upload file found"})
			return
		}
		defer file.Close()

		if header.Size > MaxFileSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "File too large, maximum supported size is 10MB"})
			return
		}

		buffer := make([]byte, 512)
		n, err := file.Read(buffer)
		if err != nil && err != io.EOF {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
			return
		}
		mimeType := http.DetectContentType(buffer[:n])

		if !isAllowedFileType(mimeType) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported file type"})
			return
		}

		file.Seek(0, 0)

		fileID := generateFileID()
		safeFilename := sanitizeFilename(header.Filename)
		ext := filepath.Ext(safeFilename)
		if ext == "" {
			ext = ".bin"
		}
		storageName := fileID + ext
		storagePath := filepath.Join(UploadDir, storageName)

		if err := os.MkdirAll(UploadDir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create upload directory"})
			return
		}

		dst, err := os.Create(storagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file"})
			return
		}

		taskID = c.PostForm("taskId")
		commentID = c.PostForm("commentId")

		if cookie, err := c.Cookie("kanban-token"); err == nil && cookie != "" {
			var userID string
			err := db.QueryRow("SELECT user_id FROM tokens WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", cookie, time.Now()).Scan(&userID)
			if err == nil {
				uploaderID = &userID
			}
		}

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

		c.JSON(http.StatusOK, gin.H{
			"id":       fileID,
			"filename": header.Filename,
			"url":      fmt.Sprintf("/uploads/%s", fileID),
			"mimeType": mimeType,
			"size":     header.Size,
		})
	}
}
