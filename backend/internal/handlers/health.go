package handlers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

const RequestIDKey = "request_id"

// ServerStartTime records when the process started serving traffic.
// It is set once via SetServerStartTime (typically from main() right
// before ListenAndServe) and read on every health probe. Using a
// package-level variable instead of a function parameter keeps the
// route registration signature (handlers.HealthCheck) unchanged so
// the existing main.go wiring does not have to be touched. The
// mutex is purely defensive: SetServerStartTime runs once at
// startup, but a future caller (e.g. a test that resets the clock)
// would otherwise race with concurrent health probes.
var (
	serverStartTime     time.Time
	serverStartTimeOnce sync.RWMutex
)

// SetServerStartTime stamps the process start time used by the
// detailed health endpoint to compute uptime. Callers should pass
// the moment the HTTP server begins listening so the reported
// uptime matches what an external load balancer would observe.
func SetServerStartTime(t time.Time) {
	serverStartTimeOnce.Lock()
	defer serverStartTimeOnce.Unlock()
	serverStartTime = t
}

func getServerStartTime() time.Time {
	serverStartTimeOnce.RLock()
	defer serverStartTimeOnce.RUnlock()
	return serverStartTime
}

// HealthResponse is the legacy shape used by the original /api/v1/health
// route. New callers should consume DetailedHealthResponse instead.
// It is kept exported so the existing test suite (and any external
// liveness probes that hard-code the field names) does not break.
type HealthResponse struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
}

// DetailedHealthResponse is the rich shape returned by the upgraded
// /api/v1/health endpoint and the new /api/v1/status endpoint. It
// is intentionally a flat object (rather than nested under a
// "health" key) so a curl | jq '."status"' probe still works after
// the upgrade. The Status field is the only one a basic monitor
// needs to read; everything else is diagnostic.
type DetailedHealthResponse struct {
	Status        string          `json:"status"`
	Timestamp     string          `json:"timestamp"`
	Version       string          `json:"version"`
	UptimeSeconds int64           `json:"uptimeSeconds"`
	Database      DatabaseHealth  `json:"database"`
	Migration     MigrationHealth `json:"migration"`
	Counts        CountsHealth    `json:"counts"`
	Agents        AgentHealth     `json:"agents"`
	Webhook       WebhookHealth   `json:"webhook"`
}

type DatabaseHealth struct {
	Type      string `json:"type"`
	Version   string `json:"version"`
	Reachable bool   `json:"reachable"`
}

type MigrationHealth struct {
	LastAppliedAt string `json:"lastAppliedAt"`
	LastVersion   string `json:"lastVersion"`
}

type CountsHealth struct {
	Tasks         int64 `json:"tasks"`
	Activities    int64 `json:"activities"`
	Activities24h int64 `json:"activitiesLast24h"`
}

type AgentHealth struct {
	Total  int64 `json:"total"`
	Active int64 `json:"active"`
}

type WebhookHealth struct {
	Enabled        bool   `json:"enabled"`
	UrlConfigured  bool   `json:"urlConfigured"`
	LastFailureAt  string `json:"lastFailureAt,omitempty"`
	RecentFailures int64  `json:"recentFailures"`
}

// HealthCheck is the public liveness probe used by /api/v1/health.
// It returns the legacy minimal shape so existing load balancer
// configurations and curl-based probes keep working. For the rich
// payload, see StatusCheck (mounted at /api/v1/status).
func HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, HealthResponse{
		Status:    "ok",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

// StatusCheck returns the full DetailedHealthResponse used by the
// public /status page. It is intentionally unauthenticated so anyone
// can confirm the instance is healthy without logging in. The
// handler degrades gracefully when the database is unavailable
// (returning 200 with status="degraded") rather than 5xx, so a
// load balancer configured to treat 2xx as healthy still works
// during transient DB outages. The detailed reason for the
// degraded state lives in the `database.reachable` flag and the
// individual count fields (which fall back to zero).
func StatusCheck(c *gin.Context) {
	now := time.Now().UTC()
	resp := DetailedHealthResponse{
		Status:        "ok",
		Timestamp:     now.Format(time.RFC3339),
		Version:       appVersion(),
		UptimeSeconds: uptimeSeconds(now),
	}

	db := currentDB(c)
	if db == nil {
		// No DB on this gin context (the lazy-setup wizard is
		// running and has not yet persisted credentials). Mark
		// the probe degraded but still answer — the operator
		// needs to see *something* on /status.
		resp.Status = "degraded"
		c.JSON(http.StatusOK, resp)
		return
	}

	fillDatabaseHealth(db, &resp.Database)
	if !resp.Database.Reachable {
		resp.Status = "degraded"
	}

	if resp.Database.Reachable {
		fillMigrationHealth(db, &resp.Migration)
		fillCountsHealth(db, &resp.Counts)
		fillAgentHealth(db, &resp.Agents)
		fillWebhookHealth(db, &resp.Webhook, now)

		// Webhook failures are a soft signal: the rest of the
		// system can keep serving traffic even if the user's
		// outbound webhook is broken. Surface it as a warning
		// rather than marking the whole instance degraded.
		if resp.Webhook.Enabled && resp.Webhook.RecentFailures > 0 {
			if resp.Status == "ok" {
				resp.Status = "degraded"
			}
		}
	}

	c.JSON(http.StatusOK, resp)
}

// currentDB pulls the *sql.DB stashed on the gin context by
// main.go's setupAPIRoutes. Tests can use SetStatusDBForTest to
// inject a different handle without going through the full router.
func currentDB(c *gin.Context) *sql.DB {
	if v, ok := c.Get(StatusDBKey); ok {
		if db, ok := v.(*sql.DB); ok {
			return db
		}
	}
	return nil
}

// fillDatabaseHealth probes the DB with a Ping and reads the
// engine version. We deliberately use PingContext with a tight
// deadline so a wedged DB does not stall the /status probe for
// the full client timeout — a slow DB still answers, just with
// reachable=false.
func fillDatabaseHealth(db *sql.DB, out *DatabaseHealth) {
	pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		out.Type = dbTypeForVersionQuery()
		out.Reachable = false
		return
	}
	out.Type = dbTypeForVersionQuery()
	out.Version = readDBVersion(db, out.Type)
	// SQLite is shipped in the binary and Ping() succeeding is
	// sufficient evidence of reachability even when the version
	// query returned blank (it never does, but we belt-and-brace).
	out.Reachable = true
}

func fillMigrationHealth(db *sql.DB, out *MigrationHealth) {
	row := db.QueryRow("SELECT version, applied_at FROM schema_version ORDER BY applied_at DESC LIMIT 1")
	var version sql.NullString
	var appliedAt sql.NullString
	if err := row.Scan(&version, &appliedAt); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Debug("status: schema_version lookup failed", "error", err)
		}
		return
	}
	if version.Valid {
		out.LastVersion = version.String
	}
	if appliedAt.Valid {
		out.LastAppliedAt = appliedAt.String
	}
}

func fillCountsHealth(db *sql.DB, out *CountsHealth) {
	if v, err := scalarQuery(db, "SELECT COUNT(*) FROM tasks"); err == nil {
		out.Tasks = v
	} else {
		slog.Debug("status: tasks count failed", "error", err)
	}
	if v, err := scalarQuery(db, "SELECT COUNT(*) FROM activities"); err == nil {
		out.Activities = v
	} else {
		slog.Debug("status: activities count failed", "error", err)
	}
	if v, err := scalarQuery(db, "SELECT COUNT(*) FROM activities WHERE created_at >= datetime('now', '-1 day')"); err == nil {
		out.Activities24h = v
	} else {
		slog.Debug("status: activities 24h count failed", "error", err)
	}
}

func fillAgentHealth(db *sql.DB, out *AgentHealth) {
	if v, err := scalarQuery(db, "SELECT COUNT(*) FROM users WHERE type = 'AGENT'"); err == nil {
		out.Total = v
	} else {
		slog.Debug("status: agent count failed", "error", err)
	}
	// "Active" means we saw an activity row for an agent in the
	// last 5 minutes. This is a cheap proxy for "still alive"
	// without requiring agents to heartbeat on a dedicated channel.
	if v, err := scalarQuery(db, "SELECT COUNT(DISTINCT user_id) FROM activities WHERE user_id IN (SELECT id FROM users WHERE type = 'AGENT') AND created_at >= datetime('now', '-5 minutes')"); err == nil {
		out.Active = v
	} else {
		slog.Debug("status: active agent count failed", "error", err)
	}
}

func fillWebhookHealth(db *sql.DB, out *WebhookHealth, _ time.Time) {
	svc := services.GetWebhookService()
	out.Enabled = svc.IsEnabled()
	out.UrlConfigured = out.Enabled

	if !out.Enabled {
		return
	}

	row := db.QueryRow(`SELECT MAX(created_at) FROM notifications WHERE source = 'WEBHOOK_FAILED'`)
	var lastFailure sql.NullString
	if err := row.Scan(&lastFailure); err != nil {
		slog.Debug("status: webhook last-failure lookup failed", "error", err)
		return
	}
	if lastFailure.Valid {
		out.LastFailureAt = lastFailure.String
	}

	if v, err := scalarQuery(db, "SELECT COUNT(*) FROM notifications WHERE source = 'WEBHOOK_FAILED' AND created_at >= datetime('now', '-1 day')"); err == nil {
		out.RecentFailures = v
	} else {
		slog.Debug("status: webhook recent-failure count failed", "error", err)
	}
}

func scalarQuery(db *sql.DB, q string) (int64, error) {
	row := db.QueryRow(q)
	var v int64
	if err := row.Scan(&v); err != nil {
		return 0, err
	}
	return v, nil
}

// dbTypeForVersionQuery inspects the active DB driver so we can
// pick the right version string. We read DB_TYPE rather than
// sniffing the driver so a misconfigured driver still reports
// the intended engine to the operator.
func dbTypeForVersionQuery() string {
	return currentDBType()
}

var (
	statusDBTypeOverride string
	statusDBTypeMu       sync.RWMutex
)

func currentDBType() string {
	statusDBTypeMu.RLock()
	defer statusDBTypeMu.RUnlock()
	if statusDBTypeOverride != "" {
		return statusDBTypeOverride
	}
	return defaultDBType()
}

// defaultDBType reads DB_TYPE from the environment with sqlite as
// the safe fallback (matching database.GetDBConfig). Centralising
// it here lets a test pin the value with t.Setenv without having
// to import the database package (which would create a cycle).
func defaultDBType() string {
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("DB_TYPE"))); v != "" {
		return v
	}
	return "sqlite"
}

func readDBVersion(db *sql.DB, dbType string) string {
	var q string
	switch dbType {
	case "mysql":
		q = "SELECT VERSION()"
	case "sqlite":
		q = "SELECT sqlite_version()"
	default:
		return ""
	}
	var v string
	if err := db.QueryRow(q).Scan(&v); err != nil {
		slog.Debug("status: db version query failed", "type", dbType, "error", err)
		return ""
	}
	return strings.TrimSpace(v)
}

func uptimeSeconds(now time.Time) int64 {
	start := getServerStartTime()
	if start.IsZero() {
		return 0
	}
	diff := now.Sub(start)
	if diff < 0 {
		return 0
	}
	return int64(diff.Seconds())
}

func appVersion() string {
	// Inline import-free fallback so the health package does not
	// pull in internal/version (which depends on git being on
	// PATH). The empty default lets dev builds render as "dev"
	// instead of pretending to be a release.
	return buildVersion
}

// buildVersion is overridden at compile time via -ldflags
// "-X open-kanban/internal/handlers.buildVersion=$VERSION".
var buildVersion = "dev"

// StatusDBKey is the gin.Context key under which main.go should
// stash the live *sql.DB so StatusCheck can read it. Exported so
// the wiring lives next to the routes and stays in sync.
const StatusDBKey = "status_db"

func RequestLoggerMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		requestID := generateRequestID()
		c.Set(RequestIDKey, requestID)
		c.Header("X-Request-ID", requestID)

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		logAttrs := []any{
			slog.String("request_id", requestID),
			slog.String("method", c.Request.Method),
			slog.String("path", path),
			slog.Int("status", status),
			slog.Duration("latency", latency),
			slog.String("ip", c.ClientIP()),
		}

		if query != "" {
			logAttrs = append(logAttrs, slog.String("query", query))
		}

		if len(c.Errors) > 0 {
			logAttrs = append(logAttrs, slog.String("errors", c.Errors.String()))
		}

		switch {
		case status >= 500:
			slog.Error("request completed", logAttrs...)
		case status >= 400:
			slog.Warn("request completed", logAttrs...)
		case gin.Mode() == gin.DebugMode:
			slog.Debug("request completed", logAttrs...)
		default:
			slog.Info("request completed", logAttrs...)
		}
	}
}

func generateRequestID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func GetRequestID(c *gin.Context) string {
	if id, exists := c.Get(RequestIDKey); exists {
		if requestID, ok := id.(string); ok {
			return requestID
		}
	}
	return ""
}
