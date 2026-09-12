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
	group.GET("/history", handlers.ListRunsHistory(db))
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
	if resp.Run["runnerId"] != "runner-A" {
		t.Errorf("expected run.runnerId=runner-A (the wire-format runner id), got %v", resp.Run["runnerId"])
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
	// Acceptance criterion: the key race case must run at least
	// 100 times to rule out an accidental pass. Each iteration
	// gets a fresh in-memory DB so state cannot leak across
	// attempts; the subtest harness surfaces which iteration
	// (if any) regresses.
	const iterations = 100
	const claimers = 4
	for i := 0; i < iterations; i++ {
		i := i
		t.Run(fmt.Sprintf("iter-%03d", i), func(t *testing.T) {
			db := setupRunsDB(t)
			defer db.Close()

			// Restrict to a single eligible task so the test design
			// collapses to "exactly one winner" — otherwise two
			// goroutines can claim different rows and both win.
			if _, err := db.Exec("DELETE FROM tasks WHERE id = 't-1'"); err != nil {
				t.Fatalf("delete t-1: %v", err)
			}

			router := runsRouter(db)

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
			for j := 0; j < claimers; j++ {
				j := j
				go func() {
					defer wg.Done()
					gate.Lock()
					defer gate.Unlock()
					w := doRequest(router, "POST", "/api/v1/runs/claim", "admin-token", map[string]interface{}{
						"boardId":   "b1",
						"status":    "todo",
						"agentType": "opencoder",
						"runnerId":  fmt.Sprintf("runner-%d-%d", i, j),
					})
					results[j] = w.Code
					bodies[j] = w.Body.String()
				}()
			}
			wg.Wait()

			winners, losers := 0, 0
			for j, c := range results {
				switch c {
				case http.StatusOK:
					winners++
				case http.StatusNoContent:
					losers++
				default:
					t.Logf("unexpected status %d (body=%s)", c, bodies[j])
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
		})
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

// TestHeartbeatRun_ConflictAfterReaper simulates the full
// reaper-then-heartbeat path: a runner claims, then crashes,
// then the background reaper flips the row to 'released' (and
// rolls the task back to its snapshot column). When the
// original runner comes back online and posts a heartbeat,
// the lock is no longer held — handler must surface 409 so the
// runner can detect its loss and exit cleanly instead of
// looping forever.
func TestHeartbeatRun_ConflictAfterReaper(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-reap-hb', 'reap+hb', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-reap-hb", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	// Drive the reaper through the repository — keeps the
	// test focused on the heartbeat contract without
	// depending on the timer-driven loop. Nudge expires_at
	// into the past first so the reaper treats the row as
	// stale.
	if _, err := db.Exec("UPDATE task_runs SET expires_at = datetime('now', '-1 minute') WHERE task_id='t-reap-hb'"); err != nil {
		t.Fatalf("expire: %v", err)
	}
	if _, err := repo.ReapExpiredRuns(true); err != nil {
		t.Fatalf("reap: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/t-reap-hb/heartbeat", "admin-token", map[string]interface{}{
		"runnerId": "u-admin",
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 after reaper released the lock, got %d: %s", w.Code, w.Body.String())
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

	// Row should be preserved (s-1106) and stamped to
	// status='completed', and the task should advance past
	// in_progress. The terminal row is now source-of-truth for
	// /api/v1/runs/history.
	var col string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-fin'").Scan(&col); err != nil {
		t.Fatalf("query: %v", err)
	}
	if col == "c-doing" || col == "c-todo" {
		t.Errorf("expected task to advance past in_progress, still in %s", col)
	}

	var runStatus string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-fin'").Scan(&runStatus); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runStatus != "completed" {
		t.Errorf("expected task_runs row stamped to 'completed', got status=%q", runStatus)
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

// TestFinishRun_ReadOnlyUserRejected guards the WRITE permission
// gate added alongside HasColumnWrite. The viewer user (u-viewer)
// has READ-only board access — even with a valid task_runs row
// owned by an admin, finish must reject them with 403 so a
// runner that lost its grant between claim and finish can't
// advance the task.
func TestFinishRun_ReadOnlyUserRejected(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES ('t-ro', 'ro', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-ro", "c-todo", "u-admin", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "POST", "/api/v1/runs/t-ro/finish", "viewer-token", map[string]interface{}{
		"runnerId": "u-admin",
		"status":   "completed",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}

	// Task_runs row should still be present — the permission
	// gate fires before the repo layer is touched.
	var status string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-ro'").Scan(&status); err != nil {
		t.Fatalf("query run: %v", err)
	}
	if status != "claimed" {
		t.Errorf("expected task_runs row untouched, got status=%s", status)
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
	// s-1106: FinishRun stamps the row to status='completed'
	// instead of DELETEing it, so the heartbeat handler now
	// sees a row in a terminal state and surfaces ErrLockHeld
	// ("this lock is no longer held by anyone") rather than
	// ErrNoRunRow ("there is no lock at all"). The handler
	// still maps both to 409, so the wire contract is the
	// same; the sentinel changes because the underlying row
	// now persists for /runs/history to enumerate.
	if _, err := repo.Heartbeat("t-lock", "u-admin", 60000); !errors.Is(err, repositories.ErrLockHeld) {
		t.Errorf("expected ErrLockHeld after finish (s-1106 preserves row), got %v", err)
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

// seedHistoryRow inserts a terminal task_runs row directly into
// the database so /runs/history tests don't have to drive the
// full claim → heartbeat → finish cycle for every fixture.
// Status must be one of completed / failed / released.
func seedHistoryRow(t *testing.T, db *sql.DB, taskID, runnerID, boardID, columnID, status string, finishedAt time.Time, exitCode *int, errMsg *string) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO task_runs (
			task_id, runner_id, agent_id, board_id, column_id, status,
			claimed_at, last_heartbeat_at, expires_at, finished_at, exit_code, error
		) VALUES (?, ?, 'opencoder', ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, taskID, runnerID, boardID, columnID, status,
		finishedAt.Add(-30*time.Second), finishedAt, finishedAt,
		finishedAt, exitCode, errMsg); err != nil {
		t.Fatalf("seed history row: %v", err)
	}
}

// TestListRunsHistory_HappyPathReturnsTerminalRows covers the
// basic contract: every terminal task_runs row (completed /
// failed / released) is returned; live rows are excluded. The
// ADMIN caller sees everything because the post-filter
// short-circuits for ADMIN.
func TestListRunsHistory_HappyPathReturnsTerminalRows(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES
		('t-h1', 'hist one', 'c-todo', 1, 'u-admin'),
		('t-h2', 'hist two', 'c-todo', 1, 'u-admin'),
		('t-h3', 'live',     'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed tasks: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	seedHistoryRow(t, db, "t-h1", "runner-A", "b1", "c-todo", "completed", now.Add(-2*time.Minute), intPtr(0), nil)
	seedHistoryRow(t, db, "t-h2", "runner-B", "b1", "c-todo", "failed", now.Add(-1*time.Minute), intPtr(1), strPtr("boom"))

	// Live row — must NOT appear in the response.
	repo := repositories.NewRunRepository(db)
	if _, err := repo.ClaimRun("b1", "t-h3", "c-todo", "runner-C", "opencoder", "c-doing", 60000); err != nil {
		t.Fatalf("claim live: %v", err)
	}

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp []models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp) != 2 {
		t.Fatalf("expected 2 terminal rows, got %d: %s", len(resp), w.Body.String())
	}
	// Order: most recent finished_at first (t-h2 then t-h1).
	if resp[0].TaskID != "t-h2" || resp[1].TaskID != "t-h1" {
		t.Errorf("expected DESC order by finished_at, got [%s, %s]", resp[0].TaskID, resp[1].TaskID)
	}
	if resp[0].Status != models.RunStatusFailed {
		t.Errorf("expected first row status=failed, got %q", resp[0].Status)
	}
	if resp[1].Status != models.RunStatusCompleted {
		t.Errorf("expected second row status=completed, got %q", resp[1].Status)
	}
}

// TestListRunsHistory_FilterByRunnerId covers the runnerId
// query parameter: only rows matching the exact runner
// identifier come back.
func TestListRunsHistory_FilterByRunnerId(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES
		('t-r1', 'r1', 'c-todo', 1, 'u-admin'),
		('t-r2', 'r2', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	now := time.Now().UTC()
	seedHistoryRow(t, db, "t-r1", "runner-A", "b1", "c-todo", "completed", now, intPtr(0), nil)
	seedHistoryRow(t, db, "t-r2", "runner-B", "b1", "c-todo", "completed", now, intPtr(0), nil)

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history?runnerId=runner-B", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp []models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp) != 1 || resp[0].RunnerID != "runner-B" {
		t.Errorf("expected single runner-B row, got %+v", resp)
	}
}

// TestListRunsHistory_FilterByStatus covers the status filter
// (completed | failed | released). Bad values return 400.
func TestListRunsHistory_FilterByStatus(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES
		('t-s1', 's1', 'c-todo', 1, 'u-admin'),
		('t-s2', 's2', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	now := time.Now().UTC()
	seedHistoryRow(t, db, "t-s1", "runner-A", "b1", "c-todo", "completed", now, intPtr(0), nil)
	seedHistoryRow(t, db, "t-s2", "runner-A", "b1", "c-todo", "failed", now, intPtr(1), strPtr("boom"))

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history?status=failed", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp []models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp) != 1 || resp[0].Status != models.RunStatusFailed {
		t.Errorf("expected one failed row, got %+v", resp)
	}

	// Bad status — 400.
	wBad := doRequest(router, "GET", "/api/v1/runs/history?status=bogus", "admin-token", nil)
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unknown status, got %d: %s", wBad.Code, wBad.Body.String())
	}
}

// TestListRunsHistory_TimeWindow covers the from / to bound:
// only rows with finished_at within the window come back.
func TestListRunsHistory_TimeWindow(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES
		('t-tw1', 'tw1', 'c-todo', 1, 'u-admin'),
		('t-tw2', 'tw2', 'c-todo', 1, 'u-admin'),
		('t-tw3', 'tw3', 'c-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)
	recent := now.Add(-30 * time.Minute)
	mid := now.Add(-2 * time.Hour)
	seedHistoryRow(t, db, "t-tw1", "runner-A", "b1", "c-todo", "completed", old, intPtr(0), nil)
	seedHistoryRow(t, db, "t-tw2", "runner-A", "b1", "c-todo", "completed", mid, intPtr(0), nil)
	seedHistoryRow(t, db, "t-tw3", "runner-A", "b1", "c-todo", "completed", recent, intPtr(0), nil)

	// Window: last 24h. t-tw1 (48h ago) is OUT; t-tw2 (2h ago)
	// and t-tw3 (30min ago) are IN.
	router := runsRouter(db)
	url := "/api/v1/runs/history?from=" + now.Add(-24*time.Hour).Format(time.RFC3339) + "&to=" + now.Format(time.RFC3339)
	w := doRequest(router, "GET", url, "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp []models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp) != 2 {
		t.Fatalf("expected 2 rows within window (t-tw2 + t-tw3), got %d: %s", len(resp), w.Body.String())
	}
	gotIDs := map[string]bool{}
	for _, r := range resp {
		gotIDs[r.TaskID] = true
	}
	if !gotIDs["t-tw2"] || !gotIDs["t-tw3"] {
		t.Errorf("expected t-tw2 + t-tw3, got %v", gotIDs)
	}
	if gotIDs["t-tw1"] {
		t.Errorf("t-tw1 (48h ago) must be excluded by 24h window")
	}

	// Date-only format (YYYY-MM-DD) must also parse — used by
	// the CLI's --since flag.
	wDate := doRequest(router, "GET", "/api/v1/runs/history?from="+now.Add(-72*time.Hour).Format("2006-01-02"), "admin-token", nil)
	if wDate.Code != http.StatusOK {
		t.Fatalf("date-only format: expected 200, got %d: %s", wDate.Code, wDate.Body.String())
	}

	// to < from → 400.
	wBad := doRequest(router, "GET", "/api/v1/runs/history?from="+now.Format(time.RFC3339)+"&to="+now.Add(-time.Hour).Format(time.RFC3339), "admin-token", nil)
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for inverted window, got %d: %s", wBad.Code, wBad.Body.String())
	}

	// Bad timestamp → 400.
	wBadTs := doRequest(router, "GET", "/api/v1/runs/history?from=not-a-date", "admin-token", nil)
	if wBadTs.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for bad timestamp, got %d: %s", wBadTs.Code, wBadTs.Body.String())
	}
}

// TestListRunsHistory_Pagination covers limit / offset. The
// repository caps limit at 200 and rejects negative offsets.
func TestListRunsHistory_Pagination(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Seed 5 rows on distinct tasks.
	values := make([]string, 0, 5)
	args := []interface{}{}
	for i := 0; i < 5; i++ {
		taskID := fmt.Sprintf("t-pg%d", i)
		values = append(values, fmt.Sprintf("('%s', 'pg %d', 'c-todo', 1, 'u-admin')", taskID, i))
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES `+strings.Join(values, ","), args...); err != nil {
		t.Fatalf("seed tasks: %v", err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < 5; i++ {
		seedHistoryRow(t, db, fmt.Sprintf("t-pg%d", i), "runner-A", "b1", "c-todo", "completed",
			base.Add(-time.Duration(i)*time.Minute), intPtr(0), nil)
	}

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history?limit=2&offset=0", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var page1 []models.TaskRun
	if err := json.Unmarshal(w.Body.Bytes(), &page1); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(page1) != 2 {
		t.Errorf("expected 2 rows on first page, got %d", len(page1))
	}
	// DESC by finished_at: page1 = [t-pg0, t-pg1].
	if page1[0].TaskID != "t-pg0" || page1[1].TaskID != "t-pg1" {
		t.Errorf("expected DESC order, got [%s, %s]", page1[0].TaskID, page1[1].TaskID)
	}

	w2 := doRequest(router, "GET", "/api/v1/runs/history?limit=2&offset=2", "admin-token", nil)
	var page2 []models.TaskRun
	if err := json.Unmarshal(w2.Body.Bytes(), &page2); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(page2) != 2 || page2[0].TaskID != "t-pg2" {
		t.Errorf("expected page2 to start with t-pg2, got %+v", page2)
	}

	// Bad limit / offset → 400.
	wBad := doRequest(router, "GET", "/api/v1/runs/history?limit=-1", "admin-token", nil)
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for negative limit, got %d", wBad.Code)
	}
	wBad2 := doRequest(router, "GET", "/api/v1/runs/history?offset=-5", "admin-token", nil)
	if wBad2.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for negative offset, got %d", wBad2.Code)
	}
	wBad3 := doRequest(router, "GET", "/api/v1/runs/history?limit=abc", "admin-token", nil)
	if wBad3.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for non-numeric limit, got %d", wBad3.Code)
	}
}

// TestListRunsHistory_EmptyResultReturnsEmptyArray covers the
// no-rows case: handler returns [] not null so the frontend
// can render the empty state without a null-guard.
func TestListRunsHistory_EmptyResultReturnsEmptyArray(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history", "admin-token", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	body := strings.TrimSpace(w.Body.String())
	if body != "[]" {
		t.Errorf("expected '[]' for empty result, got %q", body)
	}
}

// TestListRunsHistory_PermissionDeniedHidesRows covers the
// post-filter: a VIEWER who only has READ on b1 sees rows that
// originated on b1; rows from a board they have no access to
// are silently dropped.
func TestListRunsHistory_PermissionDeniedHidesRows(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	// Second board the viewer has no access to.
	if _, err := db.Exec(`INSERT INTO boards (id, name, description) VALUES ('b2', 'Hidden board', '')`); err != nil {
		t.Fatalf("seed b2: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, status, position, board_id) VALUES
		('c2-todo', 'Todo', 'todo', 0, 'b2'),
		('c2-done', 'Done', 'done', 2, 'b2')`); err != nil {
		t.Fatalf("seed b2 cols: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES
		('bp-admin-b2', 'u-admin', 'b2', 'u-admin', 'ADMIN')`); err != nil {
		t.Fatalf("seed b2 perms: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, published, created_by) VALUES
		('t-ok',  'ok',  'c-todo', 1, 'u-admin'),
		('t-hid', 'hid', 'c2-todo', 1, 'u-admin')`); err != nil {
		t.Fatalf("seed tasks: %v", err)
	}
	now := time.Now().UTC()
	seedHistoryRow(t, db, "t-ok", "runner-A", "b1", "c-todo", "completed", now, intPtr(0), nil)
	seedHistoryRow(t, db, "t-hid", "runner-A", "b2", "c2-todo", "completed", now, intPtr(0), nil)

	router := runsRouter(db)

	// Viewer — sees only b1 rows.
	wViewer := doRequest(router, "GET", "/api/v1/runs/history", "viewer-token", nil)
	if wViewer.Code != http.StatusOK {
		t.Fatalf("expected 200 for viewer, got %d: %s", wViewer.Code, wViewer.Body.String())
	}
	var viewerRows []models.TaskRun
	if err := json.Unmarshal(wViewer.Body.Bytes(), &viewerRows); err != nil {
		t.Fatalf("decode viewer: %v", err)
	}
	if len(viewerRows) != 1 || viewerRows[0].TaskID != "t-ok" {
		t.Errorf("expected viewer to see only t-ok, got %+v", viewerRows)
	}

	// Admin — sees both.
	wAdmin := doRequest(router, "GET", "/api/v1/runs/history", "admin-token", nil)
	var adminRows []models.TaskRun
	if err := json.Unmarshal(wAdmin.Body.Bytes(), &adminRows); err != nil {
		t.Fatalf("decode admin: %v", err)
	}
	if len(adminRows) != 2 {
		t.Errorf("expected admin to see both rows, got %d", len(adminRows))
	}
}

// TestListRunsHistory_Unauthenticated covers the auth gate:
// RequireAuth must reject the request before any handler logic
// runs.
func TestListRunsHistory_Unauthenticated(t *testing.T) {
	db := setupRunsDB(t)
	defer db.Close()

	router := runsRouter(db)
	w := doRequest(router, "GET", "/api/v1/runs/history", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d: %s", w.Code, w.Body.String())
	}
}

func intPtr(v int) *int       { return &v }
func strPtr(s string) *string { return &s }
