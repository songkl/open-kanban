package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

// setupStatusDB returns a minimal in-memory SQLite database
// containing just the tables the /api/v1/status handler reads
// (users / activities / tasks / notifications / schema_version)
// plus the `notifications` table that backs the webhook-failure
// counter. We deliberately do NOT seed every kanban table — the
// status handler is scoped to a small set of counters, and any
// schema drift in unrelated tables should not break this test.
func setupStatusDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
		agent_id TEXT,
		agent_prompt TEXT,
		meta TEXT,
		column_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 0,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE activities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL,
		target_type TEXT NOT NULL,
		target_id TEXT,
		target_title TEXT,
		details TEXT,
		ip_address TEXT,
		source TEXT NOT NULL DEFAULT 'web',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE notifications (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source TEXT NOT NULL,
		title TEXT,
		body TEXT,
		target_type TEXT,
		target_id TEXT,
		read_at DATETIME,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE schema_version (
		version TEXT PRIMARY KEY,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to apply schema: %v", err)
	}
	return db
}

func TestStatusCheck_HealthyReportsCounts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupStatusDB(t)
	defer db.Close()

	// Seed deterministic counts so the assertions can pin the
	// numbers exactly. We use a mix of human + agent users, a
	// single schema_version row, two tasks, three activities
	// (one inside the 24h window, two outside), and two
	// webhook-failure notifications.
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, type) VALUES
		('u-human', 'human1', 'Human One', 'HUMAN'),
		('u-agent-1', 'agent1', 'Agent One', 'AGENT'),
		('u-agent-2', 'agent2', 'Agent Two', 'AGENT')`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO schema_version (version, applied_at) VALUES
		('0.16.0', '2026-09-17 10:00:00')`); err != nil {
		t.Fatalf("seed schema_version: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES
		('t1', 'Task 1', 'col-1'),
		('t2', 'Task 2', 'col-1')`); err != nil {
		t.Fatalf("seed tasks: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO activities (id, user_id, action, target_type, created_at) VALUES
		('a-recent', 'u-agent-1', 'UPDATE_TASK', 'TASK', datetime('now', '-1 minutes')),
		('a-old-1', 'u-agent-1', 'UPDATE_TASK', 'TASK', datetime('now', '-2 days')),
		('a-old-2', 'u-human', 'LOGIN', 'USER', datetime('now', '-3 days'))`); err != nil {
		t.Fatalf("seed activities: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO notifications (id, user_id, source, created_at) VALUES
		('n1', 'u-human', 'WEBHOOK_FAILED', datetime('now', '-1 hour')),
		('n2', 'u-human', 'WEBHOOK_FAILED', datetime('now', '-2 days'))`); err != nil {
		t.Fatalf("seed notifications: %v", err)
	}

	// Pin a non-zero uptime so the response carries an integer
	// we can sanity-check against. Setting it 90 seconds in the
	// past ensures the assertion tolerates slow CI hardware.
	handlers.SetServerStartTime(time.Now().Add(-90 * time.Second))

	router := gin.New()
	router.GET("/api/v1/status", func(c *gin.Context) {
		c.Set(handlers.StatusDBKey, db)
		handlers.StatusCheck(c)
	})

	req, _ := http.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp handlers.DetailedHealthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if resp.Status != "ok" {
		t.Errorf("expected status ok, got %q (full body: %s)", resp.Status, w.Body.String())
	}
	if resp.Database.Type != "sqlite" {
		t.Errorf("expected db type sqlite, got %q", resp.Database.Type)
	}
	if !resp.Database.Reachable {
		t.Errorf("expected database.reachable=true, got false")
	}
	if resp.Database.Version == "" {
		t.Errorf("expected a sqlite version string, got empty")
	}
	if resp.Migration.LastVersion != "0.16.0" {
		t.Errorf("expected last migration 0.16.0, got %q", resp.Migration.LastVersion)
	}
	if resp.Migration.LastAppliedAt == "" {
		t.Errorf("expected a lastAppliedAt timestamp, got empty")
	}
	if resp.Counts.Tasks != 2 {
		t.Errorf("expected 2 tasks, got %d", resp.Counts.Tasks)
	}
	if resp.Counts.Activities != 3 {
		t.Errorf("expected 3 activities, got %d", resp.Counts.Activities)
	}
	if resp.Counts.Activities24h != 1 {
		t.Errorf("expected 1 activity in 24h, got %d", resp.Counts.Activities24h)
	}
	if resp.Agents.Total != 2 {
		t.Errorf("expected 2 agents, got %d", resp.Agents.Total)
	}
	if resp.Agents.Active != 1 {
		t.Errorf("expected 1 active agent (recent activity), got %d", resp.Agents.Active)
	}
	// Webhook is disabled by default in tests; failures should
	// not leak into RecentFailures when the service is off.
	if resp.Webhook.Enabled {
		t.Errorf("expected webhook disabled in default test env, got enabled")
	}
	if resp.Webhook.LastFailureAt != "" {
		t.Errorf("expected no lastFailureAt when webhook disabled, got %q", resp.Webhook.LastFailureAt)
	}
	if resp.UptimeSeconds < 60 {
		t.Errorf("expected uptime > 60s after SetServerStartTime(-90s), got %d", resp.UptimeSeconds)
	}
	if resp.Timestamp == "" {
		t.Errorf("expected a timestamp, got empty")
	}
	if resp.Version == "" {
		t.Errorf("expected a version string, got empty")
	}
}

func TestStatusCheck_MissingDBDegrades(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/v1/status", handlers.StatusCheck)

	req, _ := http.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 even when DB is missing, got %d", w.Code)
	}
	var resp handlers.DetailedHealthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Status != "degraded" {
		t.Errorf("expected status degraded when DB is missing, got %q", resp.Status)
	}
}

func TestStatusCheck_DBUnreachableMarksDegraded(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	// Closing the handle before the request makes Ping fail;
	// the handler must mark the response degraded rather than
	// returning 5xx, so an external probe can still render the
	// "DB unreachable" diagnostic.
	_ = db.Close()

	router := gin.New()
	router.GET("/api/v1/status", func(c *gin.Context) {
		c.Set(handlers.StatusDBKey, db)
		handlers.StatusCheck(c)
	})

	req, _ := http.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 even when DB is unreachable, got %d", w.Code)
	}
	var resp handlers.DetailedHealthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Status != "degraded" {
		t.Errorf("expected status degraded when DB ping fails, got %q", resp.Status)
	}
	if resp.Database.Reachable {
		t.Errorf("expected database.reachable=false after closed handle, got true")
	}
}

func TestStatusCheck_NoMigrationsYet(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupStatusDB(t)
	defer db.Close()

	// Fresh install: no schema_version rows. The handler must
	// still answer 200 with empty migration fields rather than
	// 5xx — the absence of a recorded migration is itself a
	// legitimate state worth surfacing.
	router := gin.New()
	router.GET("/api/v1/status", func(c *gin.Context) {
		c.Set(handlers.StatusDBKey, db)
		handlers.StatusCheck(c)
	})

	req, _ := http.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp handlers.DetailedHealthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Migration.LastVersion != "" {
		t.Errorf("expected empty migration version, got %q", resp.Migration.LastVersion)
	}
	if resp.Migration.LastAppliedAt != "" {
		t.Errorf("expected empty migration timestamp, got %q", resp.Migration.LastAppliedAt)
	}
	if resp.Status != "ok" {
		t.Errorf("expected ok status with no migration history, got %q", resp.Status)
	}
}
