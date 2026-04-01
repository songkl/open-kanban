package main

import (
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"strings"

	"open-kanban/internal/database"
	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

//go:embed web
var embeddedWeb embed.FS

func splitOrigins(origins string) []string {
	var result []string
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

func main() {
	// CLI commands
	resetPasswordCmd := flag.NewFlagSet("reset-password", flag.ExitOnError)
	userNickname := resetPasswordCmd.String("user", "", "User nickname")
	newPassword := resetPasswordCmd.String("password", "", "New password")

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "reset-password":
			resetPasswordCmd.Parse(os.Args[2:])
			if *userNickname == "" || *newPassword == "" {
				fmt.Println("Usage: kanban-server reset-password -user <nickname> -password <newpassword>")
				os.Exit(1)
			}
			runPasswordReset(*userNickname, *newPassword)
			return
		case "help", "--help":
			fmt.Println("Available commands:")
			fmt.Println("  reset-password -user <nickname> -password <password>  Reset user password")
			fmt.Println("  help                                                    Show this help")
			return
		}
	}

	// Initialize database
	db, err := database.InitDB()
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}

	// Create Gin router
	r := gin.New()

	// Global rate limiting middleware
	r.Use(handlers.GlobalRateLimitMiddleware())

	// CORS middleware
	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		c.Writer.Header().Set("Vary", "Origin")

		// Allow specific origins
		allowedOrigins := []string{
			"http://localhost:5173", // Vite dev server
			"http://localhost:3000", // Next.js dev server
			"http://localhost:8080", // Same origin
		}

		// Check if origin is allowed
		isAllowed := false
		allowedOrigin := ""
		for _, allowed := range allowedOrigins {
			if origin == allowed {
				isAllowed = true
				allowedOrigin = allowed
				break
			}
		}

		// Also allow if from env
		if !isAllowed && os.Getenv("ALLOWED_ORIGINS") != "" {
			for _, allowed := range splitOrigins(os.Getenv("ALLOWED_ORIGINS")) {
				if origin == allowed {
					isAllowed = true
					allowedOrigin = allowed
					break
				}
			}
		}

		if isAllowed {
			c.Writer.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		}

		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// Auth routes
	auth := r.Group("/api/auth")
	{
		auth.POST("/login", handlers.Login(db))
		auth.POST("/init", handlers.Init(db))
		auth.GET("/login", handlers.GetAvatars())
		auth.GET("/avatars", handlers.GetAvatars())
		auth.GET("/me", handlers.GetMe(db))
		auth.GET("/config", handlers.GetAppConfig(db))
	}
	authProtected := r.Group("/api/auth")
	authProtected.Use(handlers.RequireAuth(db))
	{
		authProtected.GET("/token", handlers.GetTokens(db))
		authProtected.POST("/token", handlers.CreateToken(db))
		authProtected.PUT("/token", handlers.UpdateToken(db))
		authProtected.DELETE("/token", handlers.DeleteToken(db))
		authProtected.GET("/activities", handlers.GetActivities(db))
		authProtected.GET("/agents", handlers.GetAgents(db))
		authProtected.POST("/agents", handlers.CreateAgent(db))
		authProtected.POST("/agents/reset-token", handlers.ResetAgentToken(db))
		authProtected.DELETE("/agents", handlers.DeleteAgent(db))
		authProtected.GET("/users", handlers.GetUsers(db))
		authProtected.PUT("/users", handlers.UpdateUser(db))
		authProtected.POST("/users/enabled", handlers.SetUserEnabled(db))
		authProtected.GET("/permissions", handlers.GetPermissions(db))
		authProtected.POST("/permissions", handlers.SetPermission(db))
		authProtected.DELETE("/permissions", handlers.DeletePermission(db))
		authProtected.GET("/permissions/columns", handlers.GetColumnPermissions(db))
		authProtected.POST("/permissions/columns", handlers.SetColumnPermission(db))
		authProtected.DELETE("/permissions/columns", handlers.DeleteColumnPermission(db))
		authProtected.PUT("/config", handlers.UpdateAppConfig(db))
	}

	// Boards routes - GET is public (for setup flow), others require auth
	boards := r.Group("/api/boards")
	{
		boards.GET("", handlers.GetBoards(db))
		boards.GET("/:id", handlers.GetBoard(db))
		boards.Use(handlers.RequireAuth(db))
		boards.POST("", handlers.CreateBoard(db))
		boards.POST("/from-template", handlers.CreateBoardFromTemplate(db))
		boards.PUT("/:id", handlers.UpdateBoard(db))
		boards.DELETE("/:id", handlers.DeleteBoard(db))
		boards.GET("/:id/export", handlers.ExportBoard(db))
		boards.POST("/:id/copy", handlers.CopyBoard(db))
		boards.POST("/import", handlers.ImportBoard(db))
	}

	// Templates routes
	templates := r.Group("/api/templates")
	templates.Use(handlers.RequireAuth(db))
	{
		templates.GET("", handlers.GetTemplates(db))
		templates.POST("", handlers.SaveTemplate(db))
		templates.DELETE("/:id", handlers.DeleteTemplate(db))
	}

	// Columns routes - require auth for all operations
	columns := r.Group("/api/columns")
	columns.Use(handlers.RequireAuth(db))
	{
		columns.GET("", handlers.GetColumns(db))
		columns.POST("", handlers.CreateColumn(db))
		columns.PUT("", handlers.UpdateColumn(db))
		columns.PUT("/reorder", handlers.ReorderColumns(db))
		columns.DELETE("", handlers.DeleteColumn(db))
		columns.GET("/:columnId/agent", handlers.GetColumnAgent(db))
		columns.POST("/:columnId/agent", handlers.SetColumnAgent(db))
		columns.DELETE("/:columnId/agent", handlers.DeleteColumnAgent(db))
	}

	// Tasks routes - require auth for all operations
	tasks := r.Group("/api/tasks")
	tasks.Use(handlers.RequireAuth(db))
	{
		tasks.GET("", handlers.GetTasks(db))
		tasks.POST("", handlers.CreateTask(db))
		tasks.GET("/:id", handlers.GetTask(db))
		tasks.PUT("/:id", handlers.UpdateTask(db))
		tasks.DELETE("/:id", handlers.DeleteTask(db))
		tasks.POST("/:id/archive", handlers.ArchiveTask(db))
		tasks.POST("/:id/complete", handlers.CompleteTask(db))
		tasks.GET("/:id/attachments", handlers.GetTaskAttachments(db))
	}

	// MCP routes - for MCP server to get agent-specific tasks
	r.GET("/api/mcp/my-tasks", handlers.RequireAuth(db), handlers.GetMyTasks(db))

	// Comments routes - require auth for POST, GET can be public for shared boards
	comments := r.Group("/api/comments")
	comments.Use(handlers.RequireAuth(db))
	{
		comments.GET("", handlers.GetComments(db))
		comments.GET("/:id", handlers.GetComment(db))
		comments.POST("", handlers.CreateComment(db))
	}

	// Subtasks routes - require auth for all operations
	subtasks := r.Group("/api/subtasks")
	subtasks.Use(handlers.RequireAuth(db))
	{
		subtasks.GET("", handlers.GetSubtasks(db))
		subtasks.POST("", handlers.CreateSubtask(db))
		subtasks.PUT("/:id", handlers.UpdateSubtask(db))
		subtasks.DELETE("/:id", handlers.DeleteSubtask(db))
	}

	// Archived routes - require auth
	r.GET("/api/archived", handlers.RequireAuth(db), handlers.GetArchivedTasks(db))

	// Drafts routes - require auth
	r.GET("/api/drafts", handlers.RequireAuth(db), handlers.GetDrafts(db))

	// Dashboard routes - require auth
	dashboard := r.Group("/api/dashboard")
	dashboard.Use(handlers.RequireAuth(db))
	{
		dashboard.GET("/stats", handlers.GetDashboardStats(db))
	}

	// Upload routes - require auth for upload and delete
	r.POST("/api/upload", handlers.RequireAuth(db), handlers.UploadFile(db))
	r.GET("/uploads/:id", handlers.RequireAuth(db), handlers.ServeFile(db))
	r.DELETE("/api/attachments/:id", handlers.RequireAuth(db), handlers.DeleteAttachment(db))

	// WebSocket route (same port)
	r.GET("/ws", handlers.WebSocketHandler(db))

	// Static files - serve embedded frontend by default, or from WEB_DIR if set
	webDir := os.Getenv("WEB_DIR")

	if webDir == "" {
		// Use embedded web
		subFS, err := fs.Sub(embeddedWeb, "web")
		if err != nil {
			log.Fatal("Failed to access embedded web filesystem:", err)
		}

		log.Println("Serving embedded web assets")

		mimeTypes := map[string]string{
			".js":    "application/javascript",
			".css":   "text/css",
			".html":  "text/html",
			".json":  "application/json",
			".png":   "image/png",
			".jpg":   "image/jpeg",
			".svg":   "image/svg+xml",
			".ico":   "image/x-icon",
			".woff":  "font/woff",
			".woff2": "font/woff2",
		}

		getMimeType := func(path string) string {
			ext := ""
			if i := strings.LastIndex(path, "."); i > 0 {
				ext = path[i:]
			}
			if mime, ok := mimeTypes[ext]; ok {
				return mime
			}
			return "application/octet-stream"
		}

		r.GET("/", func(c *gin.Context) {
			f, err := subFS.Open("index.html")
			if err != nil {
				c.String(404, "index.html not found")
				return
			}
			defer f.Close()
			c.Header("Cache-Control", "no-cache")
			c.Header("Content-Type", "text/html; charset=utf-8")
			io.Copy(c.Writer, f)
		})

		r.GET("/assets/*path", func(c *gin.Context) {
			path := strings.TrimPrefix(c.Param("path"), "/")
			f, err := subFS.Open("assets/" + path)
			if err != nil {
				c.String(404, "file not found")
				return
			}
			defer f.Close()
			c.Header("Content-Type", getMimeType(path))
			io.Copy(c.Writer, f)
		})

		r.NoRoute(func(c *gin.Context) {
			path := c.Request.URL.Path
			if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/ws") {
				c.JSON(404, gin.H{"error": "Not found"})
				return
			}
			f, err := subFS.Open("index.html")
			if err != nil {
				c.String(404, "index.html not found")
				return
			}
			defer f.Close()
			c.Header("Cache-Control", "no-cache")
			c.Header("Content-Type", "text/html; charset=utf-8")
			io.Copy(c.Writer, f)
		})
	} else {
		// Use external web directory
		if _, err := os.Stat(webDir); err == nil {
			log.Printf("Serving static files from: %s", webDir)

			r.GET("/", func(c *gin.Context) {
				c.File(webDir + "/index.html")
			})

			r.GET("/assets/*path", func(c *gin.Context) {
				path := c.Param("path")
				c.File(webDir + "/assets/" + path)
			})

			r.NoRoute(func(c *gin.Context) {
				path := c.Request.URL.Path
				if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/ws") {
					c.JSON(404, gin.H{"error": "Not found"})
					return
				}
				c.File(webDir + "/index.html")
			})
		} else {
			log.Printf("Warning: Web directory not found at %s, serving API only", webDir)
		}
	}

	// Get port from env
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Print startup banner
	fmt.Println("")
	fmt.Println("  ============================================")
	fmt.Println("       O P E N   K A N B A N")
	fmt.Println("  ============================================")
	fmt.Println("")
	fmt.Println("  https://github.com/songkl/open-kanban")
	fmt.Println("")
	fmt.Println("")
	log.Printf("Server starting on port %s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}

func runPasswordReset(nickname, newPassword string) {
	db, err := database.InitDB()
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Hash password with salt
	hashedPassword, err := handlers.HashPasswordWithSalt(newPassword)
	if err != nil {
		log.Fatal("Failed to hash password:", err)
	}

	result, err := db.Exec("UPDATE users SET password = ?, updated_at = datetime('now') WHERE nickname = ?", hashedPassword, nickname)
	if err != nil {
		log.Fatal("Failed to update password:", err)
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		log.Fatal("User not found: ", nickname)
	}

	fmt.Printf("Password reset successfully for user: %s\n", nickname)
}
