// e2e-runner: a tiny test-only HTTP server that mimics the production
// kanban-server with an in-memory SQLite database and a deterministic
// seed (admin user, agent token, board, columns, tasks). The CLI
// runner e2e suite (cli/tests/e2e/runner.test.ts) spawns this binary,
// waits for the "READY" line on stdout, and then exercises `kanban run`
// against it.
//
// Why not use the production cmd/server binary? The production binary
// always writes kanban.env and self-restarts when /api/v1/auth/init is
// called, which makes "wait for ready" racy in tests. The e2e-runner
// instead bypasses /init and seeds the database directly via SQL, then
// mounts only the HTTP routes the e2e suite needs.
//
// The server prints `READY <apiUrl> <adminToken>` to stdout on a
// single line, then blocks until SIGINT/SIGTERM. Errors during boot
// are printed to stderr and surface as a non-zero exit code.
//
// Port selection: fixed via the PORT env var or `--port` flag
// (default 18099).

package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
	"open-kanban/internal/handlers"
	"open-kanban/internal/models"
	"open-kanban/internal/oauth"
	"open-kanban/internal/repositories"
)

// DSN for a shared, in-memory SQLite database. `cache=shared` is
// mandatory: without it go-sqlite3 hands out a private :memory: per
// pooled connection, which means the schema created by InitDB lives
// only in one connection and the next handler request fails with
// "no such table". `journal_mode(WAL)` lets the reaper's ticker run
// concurrently with the claim handler, and `busy_timeout(5000)`
// mirrors the production SQLite config so we hit the same lock
// behaviour.
const inMemoryDSN = "file:e2e-runner.db?mode=memory&cache=shared&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"

func main() {
	port := flag.Int("port", 18099, "TCP port to listen on")
	seedBoardID := flag.String("board", "b-e2e", "ID of the seeded board")
	seedAdminToken := flag.String("token", "e2e-admin-token", "Bearer token value to grant the admin user")
	seedAgentToken := flag.String("agent-token", "e2e-agent-token", "Bearer token value the runner uses (user_agent=opencode — matches the CLI's resolveAgentType() default)")
	flag.Parse()

	if err := run(*port, *seedBoardID, *seedAdminToken, *seedAgentToken); err != nil {
		log.Fatalf("e2e-runner: %v", err)
		os.Exit(1)
	}
}

func run(port int, boardID, adminToken, agentToken string) error {
	gin.SetMode(gin.TestMode)

	// database.InitDB reads DB_TYPE + DATABASE_URL from the env, so
	// we point both at the shared-cache in-memory DSN before calling
	// it. We then run our own migrations via m.Up() rather than
	// relying on the version-keyed path InitDB uses: the production
	// path pins migrations to the current git tag, which can lag
	// behind the latest migration file when a feature lands without
	// a tag bump. The e2e suite always wants the latest schema.
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DATABASE_URL", inMemoryDSN)

	db, err := sql.Open("sqlite3", inMemoryDSN)
	if err != nil {
		return fmt.Errorf("open sqlite: %w", err)
	}
	defer db.Close()

	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return fmt.Errorf("enable FK: %w", err)
	}

	if err := runMigrationsUp(db); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	if err := seed(db, boardID, adminToken, agentToken); err != nil {
		return fmt.Errorf("seed: %w", err)
	}

	// OAuth signer + default clients — the runner doesn't go through
	// OAuth (it uses raw bearer tokens), but mounting the protected
	// routes expects the signer to be initialised.
	signer := oauth.NewSigner(db)
	if err := signer.LoadOrGenerate(); err != nil {
		return fmt.Errorf("signer: %w", err)
	}
	if err := oauth.EnsureDefaults(db); err != nil {
		return fmt.Errorf("oauth defaults: %w", err)
	}

	router := buildRouter(db, signer, adminToken)
	for _, ri := range router.Routes() {
		log.Printf("ROUTE: %s %s", ri.Method, ri.Path)
	}

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: router,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("e2e-runner: listening on :%d", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	apiURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	// `READY` line is the test's readiness probe. The token after the
	// URL is the admin bearer the suite uses to seed any further
	// state. Print to stdout so the test can parse it via
	// child_process.
	fmt.Printf("READY %s %s\n", apiURL, adminToken)

	select {
	case <-ctx.Done():
		log.Println("e2e-runner: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// runMigrationsUp runs every pending migration against db. The
// production database.InitDB() pins migrations to the current git
// tag, which is fine for tagged releases but means the e2e binary
// would miss migration 004 (task_runs) if the tag hasn't been
// bumped yet. Calling m.Up() directly sidesteps that constraint.
func runMigrationsUp(db *sql.DB) error {
	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		return fmt.Errorf("create migration driver: %w", err)
	}
	source, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		return fmt.Errorf("create migration source: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", source, "sqlite3", driver)
	if err != nil {
		return fmt.Errorf("create migrate instance: %w", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("m.Up: %w", err)
	}
	return nil
}

// buildRouter mounts every route the e2e suite exercises. We
// deliberately skip the static-asset / setup-wizard endpoints that
// the runner never touches, keeping the surface area narrow enough
// to maintain by hand.
func buildRouter(db *sql.DB, signer *oauth.Signer, adminToken string) *gin.Engine {
	r := gin.New()
	// Recovery middleware catches panics in any handler so the
	// long-lived HTTP server stays up even when a single request
	// triggers a nil-deref (e.g. the OAuth device handler hitting
	// a missing foreign-key row in a freshly-seeded DB).
	r.Use(gin.Recovery())
	r.Use(handlers.RequestLoggerMiddleware())

	// OAuth discovery routes — kept so any future curl from the suite
	// (e.g. a metadata probe) returns the same shape as production.
	r.GET("/.well-known/oauth-authorization-server", oauth.DiscoveryHandlerWithDB(db, "/oauth/device/code"))
	r.GET("/.well-known/oauth-protected-resource/mcp", oauth.ProtectedResourceHandler())
	r.GET("/.well-known/jwks.json", oauth.JWKSHandler(signer))

	// OAuth 2.1 endpoints — the CLI's `kanban auth login` walks the
	// device flow against these. We mirror the production layout so
	// the suite catches any drift between the helper and the real
	// server (e.g. endpoint URL typos in the CLI).
	//
	// Routes are registered directly on `r` rather than via a
	// r.Group("/oauth", ...) wrapper because the wrapper form
	// (with or without middleware) interacts poorly with Gin's
	// radix tree in v1.9.x when a sibling group is mounted at
	// `/.well-known/...` — every POST /oauth/* returns 404 even
	// though the routes are present in router.Routes(). The direct
	// registration sidesteps that quirk.
	oauthGate := func(c *gin.Context) {
		if !oauth.IsOAuthEnabled(db) {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error":             "oauth_disabled",
				"error_description": "OAuth 2.1 is disabled by administrator.",
			})
			return
		}
		c.Next()
	}
	r.POST("/oauth/register", oauthGate, oauth.RegisterClient(db))
	r.POST("/oauth/device/code", oauthGate, oauth.RequestDeviceCode(db))
	r.POST("/oauth/token", oauthGate, oauth.TokenEndpoint(db, signer))
	r.GET("/oauth/device/lookup", oauthGate, handlers.OptionalAuth(db), oauth.DeviceLookupHandler(db))
	r.POST("/oauth/device/approve", oauthGate, handlers.RequireAuth(db), oauth.DeviceApproveHandler(db))

	r.GET("/api/v1/health", handlers.HealthCheck)
	r.GET("/api/v1/status", handlers.HealthCheck)

	// Public auth (no middleware) — mirrors the production layout.
	authPublic := r.Group("/api/v1/auth")
	{
		authPublic.POST("/login", handlers.Login(db))
		authPublic.GET("/init-defaults", handlers.GetInitDefaults())
		authPublic.GET("/avatars", handlers.GetAvatars())
		authPublic.GET("/me", handlers.GetMe(db))
	}

	// /api/v1/users/me mirrors /api/v1/auth/me for CLI callers that use the
	// REST-style /users/me URL (see cmd/server/main.go setupAPIRoutes).
	r.GET("/api/v1/users/me", handlers.GetMe(db))

	// Protected auth endpoints used by the runner (GetMe mostly;
	// CreateToken is wired in case the suite wants to issue a fresh
	// user_agent token).
	authProtected := r.Group("/api/v1/auth")
	authProtected.Use(handlers.RequireAuth(db))
	{
		authProtected.GET("/token", handlers.GetTokens(db))
		authProtected.POST("/token", handlers.CreateToken(db))
	}

	// Boards + columns are read by the suite to assert the task moved
	// from `todo` to `review` after the run.
	boards := r.Group("/api/v1/boards")
	{
		boards.GET("", handlers.GetBoards(db))
		boards.GET("/:id", handlers.GetBoard(db))
		boards.Use(handlers.RequireAuth(db))
		boards.POST("", handlers.CreateBoard(db))
	}

	columns := r.Group("/api/v1/columns")
	{
		columns.GET("", handlers.GetColumns(db))
		columns.GET("/slug", handlers.GetColumnSlug(db))
		columns.Use(handlers.RequireAuth(db))
		columns.POST("", handlers.CreateColumn(db))
		columns.PUT("", handlers.UpdateColumn(db))
		columns.PUT("/reorder", handlers.ReorderColumns(db))
		columns.DELETE("/:id", handlers.DeleteColumn(db))
	}

	// Tasks — the runner reads `GET /tasks/:id` to hydrate the prompt,
	// and the suite uses the same endpoint to inspect column transitions.
	tasks := r.Group("/api/v1/tasks")
	{
		tasks.GET("", handlers.GetTasks(db))
		tasks.GET("/:id", handlers.GetTask(db))
		tasks.Use(handlers.RequireAuth(db))
		tasks.POST("", handlers.CreateTask(db))
		tasks.POST("/:id/complete", handlers.CompleteTask(db))
	}

	// The /runs/* surface the runner actually talks to.
	runs := r.Group("/api/v1/runs")
	runs.Use(handlers.RequireAuth(db))
	{
		runs.POST("/claim", handlers.ClaimRun(db))
		runs.POST("/release", handlers.ReleaseRuns(db))
		runs.POST("/:taskId/heartbeat", handlers.HeartbeatRun(db))
		runs.POST("/:taskId/finish", handlers.FinishRun(db))
		runs.GET("/:taskId", handlers.GetRun(db))
	}

	// Test-only auto-approval endpoint. The CLI's `kanban auth login`
	// walks the device flow on behalf of a human; the real approval
	// step (POST /oauth/device/approve) lives behind a user login
	// that the suite cannot drive without a browser. This endpoint
	// instead approves every pending device code as the seeded
	// admin user, so the CLI's first poll after registration sees
	// `approved` and returns the access token. Guarded by a static
	// token so a stray production deployment cannot accidentally
	// enable it; the CLI test suite knows the token from the
	// READY line.
	registerTestEndpoints(r, db, adminToken)

	return r
}

// registerTestEndpoints wires the helper-only routes the e2e suite
// needs to drive the CLI's device flow without a real browser.
//
// `/__test__/auto-approve` approves every pending oauth_device_codes
// row as the admin user and records consent for the matching client.
// The CLI's poll loop then returns the access token and the auth
// login completes. We require the suite's bearer token via
// Authorization (or the static X-Test-Token header for callers that
// can't easily set Authorization) so a misconfigured helper doesn't
// silently expose the endpoint on a developer's machine.
func registerTestEndpoints(r *gin.Engine, db *sql.DB, adminToken string) {
	// Auth-gating middleware for test endpoints. Two ways to
	// authenticate: the admin bearer (real Kanban token) or the
	// static X-Test-Token header (avoids having to thread the
	// admin token through the suite when it isn't relevant).
	testAuth := func(c *gin.Context) {
		if c.GetHeader("Authorization") == "Bearer "+adminToken {
			c.Next()
			return
		}
		if c.GetHeader("X-Test-Token") == adminToken {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "test endpoint requires admin bearer or X-Test-Token"})
	}
	r.POST("/__test__/auto-approve", testAuth, func(c *gin.Context) {
		rows, err := db.Query(
			"SELECT id, client_id, scope FROM oauth_device_codes WHERE status = 'pending'",
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		type pending struct {
			ID       string
			ClientID string
			Scope    string
		}
		var pendings []pending
		for rows.Next() {
			var p pending
			if err := rows.Scan(&p.ID, &p.ClientID, &p.Scope); err != nil {
				continue
			}
			pendings = append(pendings, p)
		}
		if err := rows.Err(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Approve each pending device code as the seeded admin user
		// (u-e2e-admin). The tokens table gives us a stable user_id
		// that satisfies ApproveDeviceCode's FK requirements.
		const adminUserID = "u-e2e-admin"
		approved := 0
		for _, p := range pendings {
			if _, err := db.Exec(
				"UPDATE oauth_device_codes SET status = 'approved', user_id = ? WHERE id = ? AND status = 'pending'",
				adminUserID, p.ID,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			approved++
		}
		c.JSON(http.StatusOK, gin.H{
			"approved": approved,
			"pending":  len(pendings),
		})
	})
	// suppress unused import warnings for the e2e binary when no
	// other reference pulls models into scope (the auto-approve
	// path doesn't currently construct a models.* type, but the
	// import stays in case future helpers need it).
	_ = models.TaskRunColumns
}

// seed populates the database with the minimum state needed for the
// runner e2e test to drive a full claim → heartbeat → finish cycle:
//
//   * one ADMIN user with a token whose `key` matches --token
//   * one MEMBER bot user with a token whose `key` matches --agent-token
//     and `user_agent` is "opencode" (the runner's default agent type —
//     matches CLI's resolveAgentType() default and the column_agents
//     wiring below; changing the default requires updating both)
//   * one board (--board) with WRITE permission for both users
//   * four columns: todo, in_progress, review, done
//   * column_agents wiring "opencode" onto the todo + in_progress
//     columns so the runner is allowed to claim from either
//   * two tasks in the todo column so we can prove --once stops at one
func seed(db *sql.DB, boardID, adminToken, agentToken string) error {
	now := time.Now().UTC()

	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled, created_at, updated_at)
		VALUES
			('u-e2e-admin', 'e2e-admin', 'e2e-admin', NULL, '', 'HUMAN', 'ADMIN', 1, ?, ?),
			('u-e2e-bot',   'e2e-bot',   'e2e-bot',   NULL, '', 'AGENT', 'MEMBER', 1, ?, ?)
	`, now, now, now, now); err != nil {
		return fmt.Errorf("insert users: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO tokens (id, name, key, user_id, user_agent, expires_at, created_at, updated_at)
		VALUES
			('tok-admin', 'e2e-admin', ?, 'u-e2e-admin', NULL,        NULL, ?, ?),
			('tok-bot',   'e2e-bot',   ?, 'u-e2e-bot',   'opencode', NULL, ?, ?)
	`, adminToken, now, now, agentToken, now, now); err != nil {
		return fmt.Errorf("insert tokens: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO boards (id, name, short_alias, description, task_counter, created_at, updated_at)
		VALUES (?, 'E2E Board', 'e2e', 'seeded for runner e2e', 1000, ?, ?)
	`, boardID, now, now); err != nil {
		return fmt.Errorf("insert board: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, created_at, updated_at)
		VALUES
			('bp-admin', 'u-e2e-admin', ?, 'u-e2e-admin', 'ADMIN', ?, ?),
			('bp-bot',   'u-e2e-bot',   ?, NULL,          'WRITE', ?, ?)
	`, boardID, now, now, boardID, now, now); err != nil {
		return fmt.Errorf("insert board_permissions: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO columns (id, name, status, position, color, description, board_id, created_at, updated_at)
		VALUES
			('c-e2e-todo',   'Todo',   'todo',         0, '#94a3b8', '', ?, ?, ?),
			('c-e2e-doing',  'Doing',  'in_progress',  1, '#3b82f6', '', ?, ?, ?),
			('c-e2e-review', 'Review', 'review',       2, '#a855f7', '', ?, ?, ?),
			('c-e2e-done',   'Done',   'done',         3, '#22c55e', '', ?, ?, ?)
	`, boardID, now, now, boardID, now, now, boardID, now, now, boardID, now, now); err != nil {
		return fmt.Errorf("insert columns: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO column_agents (id, column_id, agent_types, created_at, updated_at)
		VALUES
			('ca-e2e-todo',  'c-e2e-todo',  '["opencode"]', ?, ?),
			('ca-e2e-doing', 'c-e2e-doing', '["opencode"]', ?, ?)
	`, now, now, now, now); err != nil {
		return fmt.Errorf("insert column_agents: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, agent_id, agent_prompt, created_by, created_at, updated_at)
		VALUES
			('t-e2e-first',  'First task',  'seeded for runner e2e', 'medium', 'e2e-bot', NULL, 'c-e2e-todo', 1000, 1, 0, 'e2e-bot', 'do first',  'u-e2e-admin', ?, ?),
			('t-e2e-second', 'Second task', 'seeded for runner e2e', 'medium', 'e2e-bot', NULL, 'c-e2e-todo', 2000, 1, 0, 'e2e-bot', 'do second', 'u-e2e-admin', ?, ?)
	`, now, now, now, now); err != nil {
		return fmt.Errorf("insert tasks: %w", err)
	}

	// Pre-create a board_id snapshot in app_config so app-config
	// queries (some auth handlers read it) don't 500. Note the
	// lowercase `oauth_enabled` — IsOAuthEnabled reads by that key
	// specifically; the camelCase variant in some migrations is for
	// a different code path that doesn't gate the device flow.
	if _, err := db.Exec(`
		INSERT OR REPLACE INTO app_config (key, value) VALUES
			('oauth_enabled', '1'),
			('allowRegistration', '0'),
			('requirePassword', '0')
	`); err != nil {
		return fmt.Errorf("insert app_config: %w", err)
	}

	// Sanity: confirm the seeded schema matches what the repos expect.
	if _, err := repositories.NewRunRepository(db).FindInProgressColumn(boardID); err != nil {
		return fmt.Errorf("seed verification failed: %w", err)
	}
	return nil
}
