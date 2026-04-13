package handlers

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func GetWorkspaceDir() string {
	if dir := os.Getenv("WORKSPACE_DIR"); dir != "" {
		return dir
	}
	return "./workspace"
}

func UploadTextFile(db *sql.DB) gin.HandlerFunc {
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

		var req struct {
			Path    string `json:"path" binding:"required"`
			Content string `json:"content" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request: path and content are required"})
			return
		}

		workspaceDir := GetWorkspaceDir()

		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		safePath := filepath.Clean(req.Path)
		if strings.Contains(safePath, "..") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path: cannot use '..' in path"})
			return
		}

		fullPath := filepath.Join(absWorkspaceDir, safePath)
		absFullPath, err := filepath.Abs(fullPath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}

		if !strings.HasPrefix(absFullPath, absWorkspaceDir+string(filepath.Separator)) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this path is forbidden"})
			return
		}

		dir := filepath.Dir(absFullPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
			return
		}

		if err := os.WriteFile(absFullPath, []byte(req.Content), 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
			return
		}

		relPath, _ := filepath.Rel(absWorkspaceDir, absFullPath)

		c.JSON(http.StatusOK, gin.H{
			"path": relPath,
			"size": len(req.Content),
		})
	}
}

func ListWorkspaceFiles(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		subPath := c.Query("path")
		workspaceDir := GetWorkspaceDir()

		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		var searchDir string
		if subPath == "" {
			searchDir = absWorkspaceDir
		} else {
			safeSubPath := filepath.Clean(subPath)
			if strings.Contains(safeSubPath, "..") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
				return
			}
			searchDir = filepath.Join(absWorkspaceDir, safeSubPath)
		}

		absSearchDir, err := filepath.Abs(searchDir)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}

		if !strings.HasPrefix(absSearchDir, absWorkspaceDir+string(filepath.Separator)) && absSearchDir != absWorkspaceDir {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this path is forbidden"})
			return
		}

		if _, err := os.Stat(absSearchDir); err != nil {
			c.JSON(http.StatusOK, gin.H{"files": []gin.H{}})
			return
		}

		entries, err := os.ReadDir(absSearchDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read directory"})
			return
		}

		files := []gin.H{}
		for _, entry := range entries {
			info, _ := entry.Info()
			relPath, _ := filepath.Rel(absWorkspaceDir, filepath.Join(absSearchDir, entry.Name()))
			files = append(files, gin.H{
				"name":     entry.Name(),
				"path":     relPath,
				"isDir":    entry.IsDir(),
				"size":     info.Size(),
				"modified": info.ModTime().Unix(),
			})
		}

		c.JSON(http.StatusOK, gin.H{"files": files})
	}
}

func ReadWorkspaceFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		filePath := c.Param("path")
		workspaceDir := GetWorkspaceDir()

		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		fullPath := filepath.Join(absWorkspaceDir, filePath)
		absFullPath, err := filepath.Abs(fullPath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}

		if !strings.HasPrefix(absFullPath, absWorkspaceDir+string(filepath.Separator)) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this path is forbidden"})
			return
		}

		content, err := os.ReadFile(absFullPath)
		if err != nil {
			if os.IsNotExist(err) {
				c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"content": string(content),
			"size":    len(content),
		})
	}
}

func DeleteWorkspaceFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot delete files"})
			return
		}

		filePath := c.Param("path")
		workspaceDir := GetWorkspaceDir()

		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		fullPath := filepath.Join(absWorkspaceDir, filePath)
		absFullPath, err := filepath.Abs(fullPath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
			return
		}

		if !strings.HasPrefix(absFullPath, absWorkspaceDir+string(filepath.Separator)) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access to this path is forbidden"})
			return
		}

		if err := os.Remove(absFullPath); err != nil {
			if os.IsNotExist(err) {
				c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete file"})
			return
		}

		c.Status(http.StatusNoContent)
	}
}

func WorkspaceStats(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		workspaceDir := GetWorkspaceDir()

		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		if _, err := os.Stat(absWorkspaceDir); os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{
				"totalFiles":     0,
				"totalSize":      0,
				"fileCount":      0,
				"directoryCount": 0,
			})
			return
		}

		var totalFiles, totalSize int64
		var fileCount, directoryCount int

		err = filepath.Walk(absWorkspaceDir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if path == absWorkspaceDir {
				return nil
			}
			totalSize += info.Size()
			totalFiles++
			if info.IsDir() {
				directoryCount++
			} else {
				fileCount++
			}
			return nil
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to calculate stats"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"totalFiles":     totalFiles,
			"totalSize":      totalSize,
			"fileCount":      fileCount,
			"directoryCount": directoryCount,
		})
	}
}

func GetWorkspaceFileContents(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req struct {
			Paths []string `json:"paths" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
			return
		}

		workspaceDir := GetWorkspaceDir()
		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		results := make(map[string]gin.H)

		for _, filePath := range req.Paths {
			fullPath := filepath.Join(absWorkspaceDir, filePath)
			absFullPath, err := filepath.Abs(fullPath)
			if err != nil {
				results[filePath] = gin.H{"error": "Invalid path"}
				continue
			}

			if !strings.HasPrefix(absFullPath, absWorkspaceDir+string(filepath.Separator)) {
				results[filePath] = gin.H{"error": "Access denied"}
				continue
			}

			content, err := os.ReadFile(absFullPath)
			if err != nil {
				if os.IsNotExist(err) {
					results[filePath] = gin.H{"error": "File not found"}
				} else {
					results[filePath] = gin.H{"error": "Failed to read file"}
				}
				continue
			}

			results[filePath] = gin.H{
				"content": string(content),
				"size":    len(content),
			}
		}

		c.JSON(http.StatusOK, results)
	}
}

func BatchUploadTextFiles(db *sql.DB) gin.HandlerFunc {
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

		var req struct {
			Files []struct {
				Path    string `json:"path" binding:"required"`
				Content string `json:"content" binding:"required"`
			} `json:"files" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
			return
		}

		workspaceDir := GetWorkspaceDir()
		absWorkspaceDir, err := filepath.Abs(workspaceDir)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server configuration error"})
			return
		}

		results := make(map[string]gin.H)

		for _, file := range req.Files {
			safePath := filepath.Clean(file.Path)
			if strings.Contains(safePath, "..") {
				results[file.Path] = gin.H{"error": "Invalid path: cannot use '..'"}
				continue
			}

			fullPath := filepath.Join(absWorkspaceDir, safePath)
			absFullPath, err := filepath.Abs(fullPath)
			if err != nil {
				results[file.Path] = gin.H{"error": "Invalid path"}
				continue
			}

			if !strings.HasPrefix(absFullPath, absWorkspaceDir+string(filepath.Separator)) {
				results[file.Path] = gin.H{"error": "Access denied"}
				continue
			}

			dir := filepath.Dir(absFullPath)
			if err := os.MkdirAll(dir, 0755); err != nil {
				results[file.Path] = gin.H{"error": "Failed to create directory"}
				continue
			}

			if err := os.WriteFile(absFullPath, []byte(file.Content), 0644); err != nil {
				results[file.Path] = gin.H{"error": "Failed to write file"}
				continue
			}

			relPath, _ := filepath.Rel(absWorkspaceDir, absFullPath)
			results[file.Path] = gin.H{
				"path": relPath,
				"size": len(file.Content),
			}
		}

		c.JSON(http.StatusOK, results)
	}
}
