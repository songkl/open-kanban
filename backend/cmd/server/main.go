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

	"open-kanban/internal/config"
	"open-kanban/internal/database"
	"open-kanban/internal/handlers"
	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

func loadEnvFromFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	for lineNum, line := range lines {
		lineNum++
		line = strings.TrimSpace(line)

		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			log.Printf("Warning: Line %d: invalid format in config file\n", lineNum)
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])

		if key == "" {
			log.Printf("Warning: Line %d: empty key in config file\n", lineNum)
			continue
		}

		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}

	return nil
}

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

	configFilePath := flag.String("config", "", "Path to config file (reads env vars from file)")

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
			printUsage()
			return
		}
	}

	flag.Parse()

	if *configFilePath != "" {
		log.Printf("Loading config from: %s", *configFilePath)
		if err := loadEnvFromFile(*configFilePath); err != nil {
			log.Fatalf("Failed to load config file: %v", err)
		}
	}

	// Initialize config
	config.InitConfig()

	// Initialize database
	db, err := database.InitDB()
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}

	// Initialize webhook service
	services.InitWebhookService()

	// Create Gin router
	r := gin.New()

	// Structured logging middleware
	r.Use(handlers.RequestLoggerMiddleware())

	// Global rate limiting middleware
	r.Use(handlers.GlobalRateLimitMiddleware())

	// Compression middleware for API responses
	r.Use(handlers.CompressionMiddleware())

	// CORS middleware
	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		c.Writer.Header().Set("Vary", "Origin")

		// Get allowed origins from environment variable only
		allowedOrigins := splitOrigins(os.Getenv("ALLOWED_ORIGINS"))

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
	auth := r.Group("/api/v1/auth")
	{
		auth.POST("/login", handlers.Login(db))
		auth.POST("/init", handlers.Init(db))
		auth.GET("/login", handlers.GetAvatars())
		auth.GET("/avatars", handlers.GetAvatars())
		auth.GET("/me", handlers.GetMe(db))
		auth.GET("/config", handlers.GetAppConfig(db))
	}

	// Health check endpoint (public, no auth required)
	r.GET("/api/v1/health", handlers.HealthCheck)
	r.GET("/api/v1/status", handlers.HealthCheck)

	authProtected := r.Group("/api/v1/auth")
	authProtected.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
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
		authProtected.POST("/users", handlers.CreateUser(db))
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
	boards := r.Group("/api/v1/boards")
	{
		boards.GET("", handlers.GetBoards(db))
		boards.GET("/:id", handlers.GetBoard(db))
		boards.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
		boards.POST("", handlers.CreateBoard(db))
		boards.POST("/from-template", handlers.CreateBoardFromTemplate(db))
		boards.PUT("/:id", handlers.UpdateBoard(db))
		boards.DELETE("/:id", handlers.DeleteBoard(db))
		boards.GET("/:id/export", handlers.ExportBoard(db))
		boards.POST("/:id/copy", handlers.CopyBoard(db))
		boards.POST("/:id/reset", handlers.ResetBoard(db))
		boards.POST("/import", handlers.ImportBoard(db))
	}

	// Templates routes
	templates := r.Group("/api/v1/templates")
	templates.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
	{
		templates.GET("", handlers.GetTemplates(db))
		templates.POST("", handlers.SaveTemplate(db))
		templates.DELETE("/:id", handlers.DeleteTemplate(db))
	}

	// Columns routes - require auth for write operations, GET is public
	columns := r.Group("/api/v1/columns")
	{
		columns.GET("", handlers.GetColumns(db))
		columns.GET("/slug", handlers.GetColumnSlug(db))
		columns.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
		columns.POST("", handlers.CreateColumn(db))
		columns.PUT("", handlers.UpdateColumn(db))
		columns.PUT("/reorder", handlers.ReorderColumns(db))
		columns.DELETE("", handlers.DeleteColumn(db))
		columns.GET("/:columnId/agent", handlers.GetColumnAgent(db))
		columns.POST("/:columnId/agent", handlers.SetColumnAgent(db))
		columns.DELETE("/:columnId/agent", handlers.DeleteColumnAgent(db))
	}

	// Tasks routes - require auth for write operations, GET is public
	tasks := r.Group("/api/v1/tasks")
	{
		tasks.GET("", handlers.GetTasks(db))
		tasks.GET("/search", handlers.SearchTasks(db))
		tasks.GET("/:id", handlers.GetTask(db))
		tasks.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
		tasks.POST("", handlers.CreateTask(db))
		tasks.POST("/batch", handlers.BatchCreateTasks(db))
		tasks.PUT("/batch", handlers.BatchUpdateTasks(db))
		tasks.DELETE("/batch", handlers.BatchDeleteTasks(db))
		tasks.PUT("/:id", handlers.UpdateTask(db))
		tasks.DELETE("/:id", handlers.DeleteTask(db))
		tasks.POST("/:id/archive", handlers.ArchiveTask(db))
		tasks.POST("/:id/complete", handlers.CompleteTask(db))
		tasks.GET("/:id/attachments", handlers.RequireAuth(db), handlers.GetTaskAttachments(db))
	}

	// MCP routes - for MCP server to get agent-specific tasks
	r.GET("/api/v1/mcp/my-tasks", handlers.RequireSignatureVerification(), handlers.RequireAuth(db), handlers.GetMyTasks(db))

	// Comments routes - require auth for POST, GET is public
	comments := r.Group("/api/v1/comments")
	{
		comments.GET("", handlers.GetComments(db))
		comments.GET("/:id", handlers.GetComment(db))
		comments.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
		comments.POST("", handlers.CreateComment(db))
	}

	// Subtasks routes - require auth for all operations
	subtasks := r.Group("/api/v1/subtasks")
	subtasks.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
	{
		subtasks.GET("", handlers.GetSubtasks(db))
		subtasks.POST("", handlers.CreateSubtask(db))
		subtasks.PUT("/:id", handlers.UpdateSubtask(db))
		subtasks.DELETE("/:id", handlers.DeleteSubtask(db))
	}

	// Archived routes - require auth
	r.GET("/api/v1/archived", handlers.RequireSignatureVerification(), handlers.RequireAuth(db), handlers.GetArchivedTasks(db))

	// Drafts routes - require auth
	r.GET("/api/v1/drafts", handlers.RequireSignatureVerification(), handlers.RequireAuth(db), handlers.GetDrafts(db))

	// Dashboard routes - require auth
	dashboard := r.Group("/api/v1/dashboard")
	dashboard.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
	{
		dashboard.GET("/stats", handlers.GetDashboardStats(db))
	}

	// Webhook routes - require auth
	webhook := r.Group("/api/v1/webhook")
	webhook.Use(handlers.RequireSignatureVerification(), handlers.RequireAuth(db))
	{
		webhook.POST("/notify", handlers.WebhookNotify(db))
	}

	// Upload routes - require auth for upload and delete
	r.POST("/api/v1/upload", handlers.RequireSignatureVerification(), handlers.RequireAuth(db), handlers.UploadFile(db))
	r.GET("/api/v1/uploads/:id", handlers.ServeFile(db))
	r.DELETE("/api/v1/attachments/:id", handlers.RequireSignatureVerification(), handlers.RequireAuth(db), handlers.DeleteAttachment(db))

	// WebSocket route (same port)
	r.GET("/ws", handlers.WebSocketHandler(db))

	// Static files - serve embedded frontend by default, or from WEB_DIR if set
	webDir := os.Getenv("WEB_DIR")

	if webDir != "" {
		if _, err := os.Stat(webDir); err != nil {
			log.Printf("Warning: Web directory not found at %s, falling back to embedded web", webDir)
			webDir = ""
		}
	}

	useEmbedded := webDir == ""
	if useEmbedded {
		log.Println("Serving embedded web assets")
	} else {
		log.Printf("Serving static files from: %s", webDir)
	}

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

	if useEmbedded {
		subFS, err := fs.Sub(embeddedWeb, "web")
		if err != nil {
			log.Fatal("Failed to access embedded web filesystem:", err)
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
			ext := ""
			if i := strings.LastIndex(path, "."); i > 0 {
				ext = path[i:]
			}
			if ext != ".js" && ext != ".css" && ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".svg" && ext != ".ico" && ext != ".woff" && ext != ".woff2" && ext != ".ttf" && ext != ".eot" && ext != ".otf" && ext != ".webp" && ext != ".gif" && ext != ".webm" && ext != ".mp4" && ext != ".wav" && ext != ".mp3" {
				c.JSON(404, gin.H{"error": "Not found"})
				return
			}
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
			c.Status(200)
			c.Header("Cache-Control", "no-cache")
			c.Header("Content-Type", "text/html; charset=utf-8")
			io.Copy(c.Writer, f)
		})
	} else {
		r.GET("/", func(c *gin.Context) {
			c.File(webDir + "/index.html")
		})

		r.GET("/assets/*path", func(c *gin.Context) {
			path := c.Param("path")
			ext := ""
			if i := strings.LastIndex(path, "."); i > 0 {
				ext = path[i:]
			}
			if ext != ".js" && ext != ".css" && ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".svg" && ext != ".ico" && ext != ".woff" && ext != ".woff2" && ext != ".ttf" && ext != ".eot" && ext != ".otf" && ext != ".webp" && ext != ".gif" && ext != ".webm" && ext != ".mp4" && ext != ".wav" && ext != ".mp3" {
				c.JSON(404, gin.H{"error": "Not found"})
				return
			}
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
	}

	// Get port from env
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Print startup banner
	fmt.Println("")
	fmt.Println(`   dP"Yb  88""Yb 888888 88b 88     88  dP    db    88b 88 88""Yb    db    88b 88 `)
	fmt.Println(`  dP   Yb 88__dP 88__   88Yb88     88odP    dPYb   88Yb88 88__dP   dPYb   88Yb88 `)
	fmt.Println(`  Yb   dP 88"""  88""   88 Y88     88"Yb   dP__Yb  88 Y88 88""Yb  dP__Yb  88 Y88 `)
	fmt.Println(`   YbodP  88     888888 88  Y8     88  Yb dP""""Yb 88  Y8 88oodP dP""""Yb 88  Y8 `)
	fmt.Println("")
	fmt.Println("  https://github.com/songkl/open-kanban")
	fmt.Println("")
	fmt.Println("")
	log.Printf("Server starting on port %s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}

func printUsage() {
	fmt.Println("kanban-server - Open Kanban Server")
	fmt.Println("")
	fmt.Println("Usage:")
	fmt.Println("  kanban-server [options]")
	fmt.Println("  kanban-server reset-password -user <nickname> -password <password>")
	fmt.Println("")
	fmt.Println("Options:")
	fmt.Println("  -config <path>   Path to config file (reads env vars from file)")
	fmt.Println("")
	fmt.Println("Examples:")
	fmt.Println("  kanban-server -config /tmp/kanban.env")
	fmt.Println("  kanban-server -config /etc/kanban.env")
	fmt.Println("")
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
