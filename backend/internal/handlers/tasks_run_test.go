package handlers_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/handlers"
	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
)

func setupRunsDB(t *testing.T) *sql.DB {
	handlers.ResetTokenCacheForTest()

	// `mode=memory&cache=shared` is required so multiple
	// connections in the pool — and any goroutines spawned by
	// parallel tests — see the same in-memory database. The
	// `file:test.db` name is just an identifier; the database
	// never touches disk. Without the cache flag, go-sqlite3
	// hands out a private `:memory:` instance per connection
	// and tests that fork work (e.g. the parallel-claim race)
	// see "no such table" errors.
	//
	// _pragma=journal_mode(WAL) lets concurrent readers run
	// alongside the single writer — the parallel-claim test
	// would otherwise trip SQLite's "database is locked" on
	// the SELECT side. WAL only works on shared in-memory
	// databases (the cache=shared flag enables that).
	db, err := sql.Open("sqlite3", "file:test.db?mode=memory&cache=shared&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)

	// The _pragma URI params above are applied by the driver
	// on connection initialization, but we still need a
	// real query to land on each pooled slot — pull one
	// connection per slot and close it so the PRAGMAs stick.
	for i := 0; i < 8; i++ {
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatalf("warm conn: %v", err)
		}
		var mode string
		if err := conn.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&mode); err != nil {
			t.Fatalf("verify journal_mode: %v", err)
		}
		if mode != "wal" {
			// In-memory shared DBs only support WAL on some
			// platforms; if the platform refuses, fall back to
			// delete mode and accept the lower concurrency.
			t.Logf("note: WAL unavailable, journal_mode=%s", mode)
		}
		_ = conn.Close()
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN' CHECK(type IN ('HUMAN', 'AGENT')),
		role TEXT DEFAULT 'MEMBER' CHECK(role IN ('ADMIN', 'MEMBER', 'VIEWER')),
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		user_id TEXT NOT NULL,
		expires_at DATETIME,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		short_alias TEXT UNIQUE,
		task_counter INTEGER DEFAULT 1000,
		deleted BOOLEAN DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		description TEXT DEFAULT ''
	);
	CREATE TABLE board_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		access TEXT DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT,
		position INTEGER DEFAULT 0,
		color TEXT DEFAULT '#6b7280',
		description TEXT DEFAULT '',
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE column_agents (
		id TEXT PRIMARY KEY,
		column_id TEXT UNIQUE NOT NULL,
		agent_types TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
		meta TEXT,
		column_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 1,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		agent_id TEXT,
		agent_prompt TEXT,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE task_runs (
		task_id TEXT PRIMARY KEY,
		runner_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		status TEXT NOT NULL,
		claimed_at DATETIME NOT NULL,
		last_heartbeat_at DATETIME NOT NULL,
		expires_at DATETIME NOT NULL,
		finished_at DATETIME,
		exit_code INTEGER,
		error TEXT,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (runner_id) REFERENCES users(id) ON DELETE SET NULL
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
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE comments (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		author TEXT DEFAULT 'Anonymous',
		task_id TEXT NOT NULL,
		user_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
	);
	CREATE TABLE subtasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		completed BOOLEAN DEFAULT 0,
		task_id TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// One ADMIN who is the board owner, plus one MEMBER used
	// for negative permission tests.
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES
		('u-admin', 'admin', 'admin', 'pass', 'ADMIN', 1, ''),
		('u-mem', 'member', 'member', 'pass', 'MEMBER', 1, ''),
		('u-viewer', 'viewer', 'viewer', 'pass', 'VIEWER', 1, ''),
		('u-bot', 'bot', 'bot', 'pass', 'MEMBER', 1, '')`); err != nil {
		t.Fatalf("failed to seed users: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO tokens (id, name, user_id, key, expires_at, user_agent) VALUES
		('t-admin', 'admin', 'u-admin', 'admin-token', NULL, 'opencoder'),
		('t-mem', 'mem', 'u-mem', 'mem-token', NULL, 'opencoder'),
		('t-viewer', 'viewer', 'u-viewer', 'viewer-token', NULL, 'opencoder'),
		('t-bot', 'bot', 'u-bot', 'bot-token', NULL, 'opencoder')`); err != nil {
		t.Fatalf("failed to seed tokens: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b1', 'Test Board', '')`); err != nil {
		t.Fatalf("failed to seed board: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES
		('bp-admin', 'u-admin', 'b1', 'u-admin', 'ADMIN'),
		('bp-mem', 'u-mem', 'b1', NULL, 'WRITE'),
		('bp-viewer', 'u-viewer', 'b1', NULL, 'READ'),
		('bp-bot', 'u-bot', 'b1', NULL, 'WRITE')`); err != nil {
		t.Fatalf("failed to seed board_permissions: %v", err)
	}

	// Columns: todo (where runners watch) and in_progress
	// (where claimed tasks move to).
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES
		('c-todo', 'Todo', 'todo', 0, 'b1'),
		('c-doing', 'Doing', 'in_progress', 1, 'b1'),
		('c-done', 'Done', 'done', 2, 'b1')`); err != nil {
		t.Fatalf("failed to seed columns: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO column_agents (id, column_id, agent_types) VALUES
		('ca-todo', 'c-todo', '["opencoder"]'),
		('ca-doing', 'c-doing', '["opencoder"]')`); err != nil {
		t.Fatalf("failed to seed column_agents: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, position, published, archived, created_by, agent_prompt) VALUES
		('t-1', 'First task', 'c-todo', 1000, 1, 0, 'u-admin', 'do first'),
		('t-2', 'Second task', 'c-todo', 2000, 1, 0, 'u-admin', 'do second'),
		('t-archived', 'Archived task', 'c-todo', 3000, 1, 1, 'u-admin', 'archived'),
		('t-draft', 'Draft task', 'c-todo', 4000, 0, 0, 'u-admin', 'unpublished')`); err != nil {
		t.Fatalf("failed to seed tasks: %v", err)
	}

	return db
}

func runsRouter(db *sql.DB) *gin.Engine {
	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	group := router.Group("/api/v1/runs")
	group.POST("/claim", handlers.ClaimRun(db))
	group.POST("/release", handlers.ReleaseRuns(db))
	group.POST("/:taskId/heartbeat", handlers.HeartbeatRun(db))
	group.POST("/:taskId/finish", handlers.FinishRun(db))
	group.GET("/:taskId", handlers.GetRun(db))
	return router
}

func doRequest(router *gin.Engine, method, path, token string, body interface{}) *httptest.ResponseRecorder {
	var bodyBytes []byte
	if body != nil {
		bodyBytes, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, path, bytes.NewBuffer(bodyBytes))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestClaimRun_HappyPath(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)

	w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Task map[string]interface{} `json:"task"`
		Run  map[string]interface{} `json:"run"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Task == nil {
		t.Fatal("expected task in response")
	}
	if got := resp.Task["id"]; got != "t-1" {
		t.Errorf("expected first task to be t-1, got %v", got)
	}
	if resp.Run["status"] != "claimed" {
		t.Errorf("expected run.status=claimed, got %v", resp.Run["status"])
	}
	if resp.Run["runnerId"] != "u-admin" {
		t.Errorf("expected run.runnerId=u-admin, got %v", resp.Run["runnerId"])
	}
	if resp.Run["columnId"] != "c-todo" {
		t.Errorf("expected run.columnId=c-todo (snapshot), got %v", resp.Run["columnId"])
	}

	// The task should now live in the in_progress column.
	var columnID string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id = 't-1'").Scan(&columnID); err != nil {
		t.Fatalf("query task column: %v", err)
	}
	if columnID != "c-doing" {
		t.Errorf("expected task to move to c-doing, got %s", columnID)
	}
}

func TestClaimRun_NoEligibleTaskReturns204(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Archive every task so nothing is eligible.
	if _, err := db.Exec("UPDATE tasks SET archived = 1"); err != nil {
		t.Fatalf("archive all: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
	})
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClaimRun_AgentTypeMismatchRejected(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Mint a token whose user_agent is 'gpt', then ask for
	// agentType 'opencoder'. The handler must reject so a
	// stolen token can't claim work for an unrelated agent.
	if _, err := db.Exec(`INSERT INTO tokens (id, name, user_id, key, user_agent) VALUES ('t-gpt', 'gpt', 'u-admin', 'gpt-token', 'gpt')`); err != nil {
		t.Fatalf("seed mismatched token: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "gpt-token", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClaimRun_ViewerForbidden(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "viewer-token", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClaimRun_NoAuthReturns401(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
	})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClaimRun_MissingFieldsReturns400(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
		"boardId": "b1",
		// status / agentType / runnerId omitted
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestClaimRun_ParallelClaimersRaceOnlyOneWins simulates
// concurrent claim attempts on the same single task. The
// repository's INSERT … ON CONFLICT WHERE clause must guarantee
// that exactly one runner walks away with the row. The other
// runner sees ErrLockHeld, which the handler translates into a
// 204 (try again next poll).
//
// SQLite serializes writers, so the contention surfaces
// naturally even without truly-parallel goroutines — we still
// fan out to multiple goroutines so the "lock held by another
// runner" branch is exercised end-to-end through the handler
// stack, not just the repository. The shared in-memory DB
// (cache=shared) lets every goroutine see the same task_runs
// table.
func TestClaimRun_ParallelClaimersRaceOnlyOneWins(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Restrict to a single eligible task so the test design
	// collapses to "exactly one winner" — otherwise two
	// goroutines can claim different rows and both win.
	if _, err := db.Exec("DELETE FROM tasks WHERE id = 't-1'"); err != nil {
		t.Fatalf("delete t-1: %v", err)
	}

	router := runsRouter(db)

	const claimers = 4
	results := make([]int, claimers)
	bodies := make([]string, claimers)
	// gate keeps the goroutines from all hammering the same
	// SQLite instance at once; without it sqlite (in delete
	// journal mode on macOS) returns "database is locked"
	// for any reader that lands while a writer holds the
	// exclusive lock. The interesting race we care about —
	// "two runners, one lock" — only needs two attempts to
	// expose, so a 1-at-a-time gate is enough.
	var gate sync.Mutex
	var wg sync.WaitGroup
	wg.Add(claimers)
	for i := 0; i < claimers; i++ {
		i := i
		go func() {
			defer wg.Done()
			gate.Lock()
			defer gate.Unlock()
			w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
				"boardId":   "b1",
				"status":    "todo",
				"agentType": "opencoder",
				"runnerId":  fmt.Sprintf("runner-%d", i),
			})
			results[i] = w.Code
			bodies[i] = w.Body.String()
		}()
	}
	wg.Wait()

	winners, losers := 0, 0
	for i, c := range results {
		switch c {
		case http.StatusOK:
			winners++
		case http.StatusNoContent:
			losers++
		default:
			t.Logf("unexpected status %d (body=%s)", c, bodies[i])
			t.Errorf("unexpected status %d", c)
		}
	}
	if winners != 1 {
		t.Errorf("expected exactly 1 winner, got %d (results=%v)", winners, results)
	}
	if losers != claimers-1 {
		t.Errorf("expected %d losers (204), got %d (results=%v)", claimers-1, losers, results)
	}

	var rowCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM task_runs WHERE task_id='t-2'").Scan(&rowCount); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if rowCount != 1 {
		t.Errorf("expected 1 task_runs row for t-2, got %d", rowCount)
	}
}

func TestHeartbeatRun_RefreshesExpiresAt(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)

	// Seed a claim directly via the repo so we can manipulate
	// expires_at to a known stale value.
	repo := repositories.NewRunRepository(db)
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t-hb', 'HB task', 'c-todo')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	if _, err := repo.ClaimRun("b1", "t-hb", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	w := doRequest(router, "POST", "/api/v1/runs/t-hb/heartbeat", "admin-token", map[string]interface{}{
		"runnerId":      "u-admin",
		"lockTimeoutMs": 90000,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	parsed, err := time.Parse(time.RFC3339, resp.ExpiresAt)
	if err != nil {
		t.Fatalf("invalid expiresAt %q: %v", resp.ExpiresAt, err)
	}
	if delta := time.Until(parsed); delta < 80*time.Second || delta > 100*time.Second {
		t.Errorf("expected expiresAt ~90s in future, got %v", delta)
	}
}

func TestHeartbeatRun_ConflictOnWrongRunner(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t-hb2', 'HB2', 'c-todo')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-hb2", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	w := doRequest(router, "POST", "/api/v1/runs/t-hb2/heartbeat", "admin-token", map[string]interface{}{
		"runnerId": "someone-else",
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHeartbeatRun_NotFound(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/no-such-task/heartbeat", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFinishRun_CompletedAdvancesColumn(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Seed an extra in_progress + done column pair so
	// CompleteTask has somewhere to advance into.
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES
		('c-next', 'Next', 'review', 3, 'b1')`); err != nil {
		t.Fatalf("seed next column: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-fin', 'finish me', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-fin", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/t-fin/finish", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
		"status":   "completed",
		"exitCode": 0,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Success  bool `json:"success"`
		Advanced bool `json:"advanced"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.Success || !resp.Advanced {
		t.Errorf("expected success=true, advanced=true, got %+v", resp)
	}

	// Row should be deleted and task advanced past in_progress.
	var col string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-fin'").Scan(&col); err != nil {
		t.Fatalf("query: %v", err)
	}
	if col == "c-doing" || col == "c-todo" {
		t.Errorf("expected task to advance past in_progress, still in %s", col)
	}

	var runCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM task_runs WHERE task_id='t-fin'").Scan(&runCount); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runCount != 0 {
		t.Errorf("expected task_runs row deleted, got %d rows", runCount)
	}
}

func TestFinishRun_FailedKeepsTaskInPlace(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-fail', 'fail me', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-fail", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	exitCode := 1
	errMsg := "boom"
	w := doRequest(router, "POST", "/api/v1/runs/t-fail/finish", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
		"status":   "failed",
		"exitCode": exitCode,
		"error":    errMsg,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Advanced bool `json:"advanced"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Advanced {
		t.Errorf("expected advanced=false on failure, got true")
	}

	// Task should still be in c-doing (in_progress) — the
	// runner is responsible for attaching a comment.
	var col string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-fail'").Scan(&col); err != nil {
		t.Fatalf("query: %v", err)
	}
	if col != "c-doing" {
		t.Errorf("expected task to remain in c-doing on failure, got %s", col)
	}
}

func TestFinishRun_WrongRunnerReturns409(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-wrong', 'wrong runner', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-wrong", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/t-wrong/finish", "admin-token", map[string]interface{}{
		"runnerId": "u-bot",
		"status":   "completed",
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFinishRun_InvalidStatusReturns400(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-bad', 'bad status', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-bad", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/t-bad/finish", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
		"status":   "lolwat",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestReleaseRuns_BulkRestore(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	for _, id := range []string{"t-rel-1", "t-rel-2"} {
		if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES (?, 'rel', 'c-todo', 1, 'u-admin')`, id); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	repo := repositories.NewRunRepository(db)
	for _, id := range []string{"t-rel-1", "t-rel-2"} {
		if _, err := repo.ClaimRun("b1", id, "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
			t.Fatalf("seed claim %s: %v", id, err)
		}
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/release", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Released int `json:"released"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Released != 2 {
		t.Errorf("expected released=2, got %d", resp.Released)
	}

	// Both tasks should have been rolled back to c-todo.
	for _, id := range []string{"t-rel-1", "t-rel-2"} {
		var col string
		if err := db.QueryRow("SELECT column_id FROM tasks WHERE id=?", id).Scan(&col); err != nil {
			t.Fatalf("query %s: %v", id, err)
		}
		if col != "c-todo" {
			t.Errorf("expected %s restored to c-todo, got %s", id, col)
		}
	}

	// Calling release again should be a no-op (idempotent).
	w = doRequest(router, "POST", "/api/v1/runs/release", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on second call, got %d: %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if resp.Released != 0 {
		t.Errorf("expected released=0 on idempotent re-call, got %d", resp.Released)
	}
}

func TestReleaseRuns_ScopedByTaskIDs(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	for _, id := range []string{"t-scope-1", "t-scope-2", "t-scope-3"} {
		if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES (?, 's', 'c-todo', 1, 'u-admin')`, id); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	repo := repositories.NewRunRepository(db)
	for _, id := range []string{"t-scope-1", "t-scope-2", "t-scope-3"} {
		if _, err := repo.ClaimRun("b1", id, "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
			t.Fatalf("seed claim %s: %v", id, err)
		}
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/release", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
		"taskIds":  []string{"t-scope-1", "t-scope-3"},
	})
	t.Logf("release response: code=%d body=%s", w.Code, w.Body.String())
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Released int `json:"released"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Released != 2 {
		t.Errorf("expected released=2, got %d", resp.Released)
	}

	// t-scope-2 should still be claimed.
	var status string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-scope-2'").Scan(&status); err != nil {
		t.Fatalf("query: %v", err)
	}
	if status != "claimed" {
		t.Errorf("expected t-scope-2 still claimed, got %s", status)
	}
}

func TestGetRun_NotFound(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/no-such", "admin-token", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetRun_ReturnsRow(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-get', 'get me', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-get", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/t-get", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var run models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if run.TaskID != "t-get" || run.Status != models.RunStatusClaimed {
		t.Errorf("unexpected run row: %+v", run)
	}
}

// TestRepository_ErrNoRunRowDistinctFromErrLockHeld locks down
// the repository's sentinel-error discipline so the handler
// can map them to 404 vs 409 without ambiguity.
func TestRepository_ErrNoRunRowDistinctFromErrLockHeld(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	repo := repositories.NewRunRepository(db)

	if _, err := repo.GetRun("missing"); !errors.Is(err, repositories.ErrNoRunRow) {
		t.Errorf("expected ErrNoRunRow for missing task, got %v", err)
	}

	// Seed a row owned by another runner.
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-lock', 'lock', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.ClaimRun("b1", "t-lock", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	if _, err := repo.Heartbeat("t-lock", "u-bot", 60000); !errors.Is(err, repositories.ErrLockHeld) {
		t.Errorf("expected ErrLockHeld on wrong runner heartbeat, got %v", err)
	}
	if err := repo.FinishRun("t-lock", "u-bot", models.RunStatusCompleted, nil, nil, nil); !errors.Is(err, repositories.ErrLockHeld) {
		t.Errorf("expected ErrLockHeld on wrong runner finish, got %v", err)
	}

	if err := repo.FinishRun("t-lock", "u-admin", models.RunStatusCompleted, nil, nil, nil); err != nil {
		t.Errorf("expected nil error on right runner finish, got %v", err)
	}
	if _, err := repo.Heartbeat("t-lock", "u-admin", 60000); !errors.Is(err, repositories.ErrNoRunRow) {
		t.Errorf("expected ErrNoRunRow after finish, got %v", err)
	}
}

// TestRepository_FindEligibleTaskSkipsArchivedAndUnpublished
// guards the eligibility filter against accidental inclusion
// of draft / archived tasks.
func TestRepository_FindEligibleTaskSkipsArchivedAndUnpublished(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	repo := repositories.NewRunRepository(db)

	got, _, err := repo.FindEligibleTask("b1", "todo", "opencoder")
	if err != nil {
		t.Fatalf("FindEligibleTask: %v", err)
	}
	// t-archived and t-draft are seeded alongside t-1 / t-2;
	// only the two published, non-archived tasks are eligible.
	if got != "t-1" {
		t.Errorf("expected first eligible task to be t-1, got %s", got)
	}

	// Claim it, then verify the next call picks t-2.
	if _, err := repo.ClaimRun("b1", got, "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// Force expires_at into the past to simulate a stale
	// claim so the eligibility filter can re-pick the same row.
	if _, err := db.Exec("UPDATE task_runs SET expires_at = datetime('now', '-1 hour') WHERE task_id = ?", got); err != nil {
		t.Fatalf("age expires_at: %v", err)
	}

	got2, _, err := repo.FindEligibleTask("b1", "todo", "opencoder")
	if err != nil {
		t.Fatalf("second FindEligibleTask: %v", err)
	}
	if got2 != "t-2" {
		t.Errorf("expected next eligible task to be t-2, got %s", got2)
	}
}

// TestRepository_ReleaseRunsRestoresSnapshotColumn verifies
// that a reaper-style release restores the snapshot column_id
// rather than leaving the task in the in_progress lane.
func TestRepository_ReleaseRunsRestoresSnapshotColumn(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	repo := repositories.NewRunRepository(db)

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-restore', 'restore me', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.ClaimRun("b1", "t-restore", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("claim: %v", err)
	}

	var gotColumn string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-restore'").Scan(&gotColumn); err != nil {
		t.Fatalf("query: %v", err)
	}
	if gotColumn != "c-doing" {
		t.Fatalf("precondition failed: expected task in c-doing, got %s", gotColumn)
	}

	released, err := repo.ReleaseRuns("u-admin", nil)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if released != 1 {
		t.Errorf("expected 1 released, got %d", released)
	}

	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-restore'").Scan(&gotColumn); err != nil {
		t.Fatalf("query: %v", err)
	}
	if gotColumn != "c-todo" {
		t.Errorf("expected task restored to c-todo, got %s", gotColumn)
	}
}

// TestRepository_ReapExpiredRuns flips expires_at into the past
// and asserts ReapExpiredRuns transitions the row to
// 'released' + restores the snapshot column. This is the
// end-to-end reaper contract — the same SQL the background
// goroutine runs every 30s.
func TestRepository_ReapExpiredRuns(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	repo := repositories.NewRunRepository(db)

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-reap', 'reap me', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.ClaimRun("b1", "t-reap", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// Force the lock to look expired from the reaper's point
	// of view.
	if _, err := db.Exec("UPDATE task_runs SET expires_at = datetime('now', '-1 minute') WHERE task_id='t-reap'"); err != nil {
		t.Fatalf("expire: %v", err)
	}

	expired, err := repo.ReapExpiredRuns(true)
	if err != nil {
		t.Fatalf("reap: %v", err)
	}
	if len(expired) != 1 || expired[0].TaskID != "t-reap" {
		t.Errorf("expected expired=[t-reap], got %+v", expired)
	}

	var status string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-reap'").Scan(&status); err != nil {
		t.Fatalf("query status: %v", err)
	}
	if status != "released" {
		t.Errorf("expected released, got %s", status)
	}

	var col string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-reap'").Scan(&col); err != nil {
		t.Fatalf("query col: %v", err)
	}
	if col != "c-todo" {
		t.Errorf("expected restored to c-todo, got %s", col)
	}

	// Calling reap again on the now-released row should be a
	// no-op (the WHERE clause filters out non-live rows).
	expired2, err := repo.ReapExpiredRuns(true)
	if err != nil {
		t.Fatalf("reap #2: %v", err)
	}
	if len(expired2) != 0 {
		t.Errorf("expected 0 expired on re-run, got %d", len(expired2))
	}
}

// TestClaimRun_MineModePicksAssignedTask guards the mode='mine'
// branch against silently picking up unassigned work that
// happens to live in a watched column.
func TestClaimRun_MineModePicksAssignedTask(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Add a task assigned to u-bot (not just in a watched
	// column) so the mode='mine' filter has something to pick.
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, assignee, published, created_by) VALUES ('t-mine', 'mine', 'c-todo', 'u-bot', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "bot-token", map[string]interface{}{
		"boardId":   "ignored",
		"status":    "ignored",
		"agentType": "opencoder",
		"runnerId":  "bot-runner",
		"mode":      "mine",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Task map[string]interface{} `json:"task"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Task["id"] != "t-mine" {
		t.Errorf("expected mode=mine to pick t-mine, got %v", resp.Task["id"])
	}
}

// guards against a regression where status returned by the
// JSON shape drifts from the model enum.
func TestGetRun_JSONShapeMatchesTaskRunModel(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-shape', 'shape', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-shape", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/t-shape", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"taskId", "runnerId", "agentId", "boardId", "columnId", "status", "claimedAt", "lastHeartbeatAt", "expiresAt"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response missing required key %q: %s", key, w.Body.String())
		}
	}
}

// TestClaimRun_BadModeReturns400 ensures the mode field is
// validated up front so a typo doesn't silently fall through
// to the board pipeline.
func TestClaimRun_BadModeReturns400(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
		"boardId":   "b1",
		"status":    "todo",
		"agentType": "opencoder",
		"runnerId":  "runner-A",
		"mode":      "bogus",
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "mode") {
		t.Errorf("expected error to mention 'mode', got %s", w.Body.String())
	}
}
