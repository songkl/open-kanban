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

func deprecationMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Deprecation", "true")
		c.Header("Sunset", "Sat, 01 Jan 2028 00:00:00 GMT")
		c.Header("Link", "</api/v1/>; rel=\"successor-version\"")
		c.Next()
	}
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

	// Structured logging middleware
	r.Use(handlers.RequestLoggerMiddleware())

	// Global rate limiting middleware
	r.Use(handlers.GlobalRateLimitMiddleware())

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

	// Auth routes (deprecated)
	auth := r.Group("/api/auth")
	auth.Use(deprecationMiddleware())
	{
		auth.POST("/login", handlers.Login(db))
		auth.POST("/init", handlers.Init(db))
		auth.GET("/login", handlers.GetAvatars())
		auth.GET("/avatars", handlers.GetAvatars())
		auth.GET("/me", handlers.GetMe(db))
		auth.GET("/config", handlers.GetAppConfig(db))
	}

	// Auth routes v1
	authV1 := r.Group("/api/v1/auth")
	{
		authV1.POST("/login", handlers.Login(db))
		authV1.POST("/init", handlers.Init(db))
		authV1.GET("/login", handlers.GetAvatars())
		authV1.GET("/avatars", handlers.GetAvatars())
		authV1.GET("/me", handlers.GetMe(db))
		authV1.GET("/config", handlers.GetAppConfig(db))
	}

	// Health check endpoint (public, no auth required) - deprecated
	r.GET("/api/health", deprecationMiddleware(), handlers.HealthCheck)
	r.GET("/api/status", deprecationMiddleware(), handlers.HealthCheck)

	// Health check endpoint v1 (public, no auth required)
	r.GET("/api/v1/health", handlers.HealthCheck)
	r.GET("/api/v1/status", handlers.HealthCheck)

	authProtected := r.Group("/api/auth")
	authProtected.Use(deprecationMiddleware(), handlers.RequireAuth(db))
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

	authProtectedV1 := r.Group("/api/v1/auth")
	authProtectedV1.Use(handlers.RequireAuth(db))
	{
		authProtectedV1.GET("/token", handlers.GetTokens(db))
		authProtectedV1.POST("/token", handlers.CreateToken(db))
		authProtectedV1.PUT("/token", handlers.UpdateToken(db))
		authProtectedV1.DELETE("/token", handlers.DeleteToken(db))
		authProtectedV1.GET("/activities", handlers.GetActivities(db))
		authProtectedV1.GET("/agents", handlers.GetAgents(db))
		authProtectedV1.POST("/agents", handlers.CreateAgent(db))
		authProtectedV1.POST("/agents/reset-token", handlers.ResetAgentToken(db))
		authProtectedV1.DELETE("/agents", handlers.DeleteAgent(db))
		authProtectedV1.GET("/users", handlers.GetUsers(db))
		authProtectedV1.PUT("/users", handlers.UpdateUser(db))
		authProtectedV1.POST("/users/enabled", handlers.SetUserEnabled(db))
		authProtectedV1.GET("/permissions", handlers.GetPermissions(db))
		authProtectedV1.POST("/permissions", handlers.SetPermission(db))
		authProtectedV1.DELETE("/permissions", handlers.DeletePermission(db))
		authProtectedV1.GET("/permissions/columns", handlers.GetColumnPermissions(db))
		authProtectedV1.POST("/permissions/columns", handlers.SetColumnPermission(db))
		authProtectedV1.DELETE("/permissions/columns", handlers.DeleteColumnPermission(db))
		authProtectedV1.PUT("/config", handlers.UpdateAppConfig(db))
	}

	// Boards routes - GET is public (for setup flow), others require auth (deprecated)
	boards := r.Group("/api/boards")
	boards.Use(deprecationMiddleware())
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
		boards.POST("/:id/reset", handlers.ResetBoard(db))
		boards.POST("/import", handlers.ImportBoard(db))
	}

	// Boards routes v1 - GET is public (for setup flow), others require auth
	boardsV1 := r.Group("/api/v1/boards")
	{
		boardsV1.GET("", handlers.GetBoards(db))
		boardsV1.GET("/:id", handlers.GetBoard(db))
		boardsV1.Use(handlers.RequireAuth(db))
		boardsV1.POST("", handlers.CreateBoard(db))
		boardsV1.POST("/from-template", handlers.CreateBoardFromTemplate(db))
		boardsV1.PUT("/:id", handlers.UpdateBoard(db))
		boardsV1.DELETE("/:id", handlers.DeleteBoard(db))
		boardsV1.GET("/:id/export", handlers.ExportBoard(db))
		boardsV1.POST("/:id/copy", handlers.CopyBoard(db))
		boardsV1.POST("/:id/reset", handlers.ResetBoard(db))
		boardsV1.POST("/import", handlers.ImportBoard(db))
	}

	// Templates routes (deprecated)
	templates := r.Group("/api/templates")
	templates.Use(deprecationMiddleware(), handlers.RequireAuth(db))
	{
		templates.GET("", handlers.GetTemplates(db))
		templates.POST("", handlers.SaveTemplate(db))
		templates.DELETE("/:id", handlers.DeleteTemplate(db))
	}

	// Templates routes v1
	templatesV1 := r.Group("/api/v1/templates")
	templatesV1.Use(handlers.RequireAuth(db))
	{
		templatesV1.GET("", handlers.GetTemplates(db))
		templatesV1.POST("", handlers.SaveTemplate(db))
		templatesV1.DELETE("/:id", handlers.DeleteTemplate(db))
	}

	// Columns routes - require auth for all operations (deprecated)
	columns := r.Group("/api/columns")
	columns.Use(deprecationMiddleware(), handlers.RequireAuth(db))
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

	// Columns routes v1 - require auth for all operations
	columnsV1 := r.Group("/api/v1/columns")
	columnsV1.Use(handlers.RequireAuth(db))
	{
		columnsV1.GET("", handlers.GetColumns(db))
		columnsV1.POST("", handlers.CreateColumn(db))
		columnsV1.PUT("", handlers.UpdateColumn(db))
		columnsV1.PUT("/reorder", handlers.ReorderColumns(db))
		columnsV1.DELETE("", handlers.DeleteColumn(db))
		columnsV1.GET("/:columnId/agent", handlers.GetColumnAgent(db))
		columnsV1.POST("/:columnId/agent", handlers.SetColumnAgent(db))
		columnsV1.DELETE("/:columnId/agent", handlers.DeleteColumnAgent(db))
	}

	// Tasks routes - require auth for all operations (deprecated)
	tasks := r.Group("/api/tasks")
	tasks.Use(deprecationMiddleware(), handlers.RequireAuth(db))
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

	// Tasks routes v1 - require auth for all operations
	tasksV1 := r.Group("/api/v1/tasks")
	tasksV1.Use(handlers.RequireAuth(db))
	{
		tasksV1.GET("", handlers.GetTasks(db))
		tasksV1.POST("", handlers.CreateTask(db))
		tasksV1.GET("/:id", handlers.GetTask(db))
		tasksV1.PUT("/:id", handlers.UpdateTask(db))
		tasksV1.DELETE("/:id", handlers.DeleteTask(db))
		tasksV1.POST("/:id/archive", handlers.ArchiveTask(db))
		tasksV1.POST("/:id/complete", handlers.CompleteTask(db))
		tasksV1.GET("/:id/attachments", handlers.GetTaskAttachments(db))
	}

	// MCP routes - for MCP server to get agent-specific tasks (deprecated)
	r.GET("/api/mcp/my-tasks", deprecationMiddleware(), handlers.RequireAuth(db), handlers.GetMyTasks(db))

	// MCP routes v1 - for MCP server to get agent-specific tasks
	r.GET("/api/v1/mcp/my-tasks", handlers.RequireAuth(db), handlers.GetMyTasks(db))

	// Comments routes - require auth for POST, GET can be public for shared boards (deprecated)
	comments := r.Group("/api/comments")
	comments.Use(deprecationMiddleware(), handlers.RequireAuth(db))
	{
		comments.GET("", handlers.GetComments(db))
		comments.GET("/:id", handlers.GetComment(db))
		comments.POST("", handlers.CreateComment(db))
	}

	// Comments routes v1 - require auth for POST, GET can be public for shared boards
	commentsV1 := r.Group("/api/v1/comments")
	commentsV1.Use(handlers.RequireAuth(db))
	{
		commentsV1.GET("", handlers.GetComments(db))
		commentsV1.GET("/:id", handlers.GetComment(db))
		commentsV1.POST("", handlers.CreateComment(db))
	}

	// Subtasks routes - require auth for all operations (deprecated)
	subtasks := r.Group("/api/subtasks")
	subtasks.Use(deprecationMiddleware(), handlers.RequireAuth(db))
	{
		subtasks.GET("", handlers.GetSubtasks(db))
		subtasks.POST("", handlers.CreateSubtask(db))
		subtasks.PUT("/:id", handlers.UpdateSubtask(db))
		subtasks.DELETE("/:id", handlers.DeleteSubtask(db))
	}

	// Subtasks routes v1 - require auth for all operations
	subtasksV1 := r.Group("/api/v1/subtasks")
	subtasksV1.Use(handlers.RequireAuth(db))
	{
		subtasksV1.GET("", handlers.GetSubtasks(db))
		subtasksV1.POST("", handlers.CreateSubtask(db))
		subtasksV1.PUT("/:id", handlers.UpdateSubtask(db))
		subtasksV1.DELETE("/:id", handlers.DeleteSubtask(db))
	}

	// Archived routes - require auth (deprecated)
	r.GET("/api/archived", deprecationMiddleware(), handlers.RequireAuth(db), handlers.GetArchivedTasks(db))

	// Archived routes v1 - require auth
	r.GET("/api/v1/archived", handlers.RequireAuth(db), handlers.GetArchivedTasks(db))

	// Drafts routes - require auth (deprecated)
	r.GET("/api/drafts", deprecationMiddleware(), handlers.RequireAuth(db), handlers.GetDrafts(db))

	// Drafts routes v1 - require auth
	r.GET("/api/v1/drafts", handlers.RequireAuth(db), handlers.GetDrafts(db))

	// Dashboard routes - require auth (deprecated)
	dashboard := r.Group("/api/dashboard")
	dashboard.Use(deprecationMiddleware(), handlers.RequireAuth(db))
	{
		dashboard.GET("/stats", handlers.GetDashboardStats(db))
	}

	// Dashboard routes v1 - require auth
	dashboardV1 := r.Group("/api/v1/dashboard")
	dashboardV1.Use(handlers.RequireAuth(db))
	{
		dashboardV1.GET("/stats", handlers.GetDashboardStats(db))
	}

	// Upload routes - require auth for upload and delete (deprecated)
	r.POST("/api/upload", deprecationMiddleware(), handlers.RequireAuth(db), handlers.UploadFile(db))
	r.GET("/uploads/:id", handlers.ServeFile(db))
	r.DELETE("/api/attachments/:id", deprecationMiddleware(), handlers.RequireAuth(db), handlers.DeleteAttachment(db))

	// Upload routes v1 - require auth for upload and delete
	r.POST("/api/v1/upload", handlers.RequireAuth(db), handlers.UploadFile(db))
	r.GET("/api/v1/uploads/:id", handlers.ServeFile(db))
	r.DELETE("/api/v1/attachments/:id", handlers.RequireAuth(db), handlers.DeleteAttachment(db))

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
