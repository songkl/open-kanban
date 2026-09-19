package handlers_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"open-kanban/internal/handlers"
	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

// capturedLog is the projection of an slog.Record the transition-
// trigger tests need to inspect. We can't pass the live slog.Record
// out of the handler goroutine because its Attrs method is a
// callback (no slice accessor), so we copy the message and the
// edge / agent_id attributes into a plain struct at Handle() time.
type capturedLog struct {
	Message string
	Edge    string
	AgentID string
}

// captureTransitionLogs installs a slog handler that records every
// emitted record into a thread-safe slice, runs fn, then restores
// the prior default logger. Used by the transition-trigger tests
// to verify that the PUT /tasks/{id} path actually wakes the
// bound Agent without needing a live webhook / Agent runner.
func captureTransitionLogs(t *testing.T) func() []capturedLog {
	t.Helper()
	var (
		mu      sync.Mutex
		records []capturedLog
	)
	handler := slogTransitionHandler{
		mu:      &mu,
		records: &records,
	}
	prev := slog.Default()
	slog.SetDefault(slog.New(handler))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return func() []capturedLog {
		mu.Lock()
		defer mu.Unlock()
		out := make([]capturedLog, len(records))
		copy(out, records)
		return out
	}
}

// slogTransitionHandler captures slog records into a slice so the
// trigger tests can assert that the right edge / agent_id pair was
// emitted by the handler goroutine.
type slogTransitionHandler struct {
	mu      *sync.Mutex
	records *[]capturedLog
}

func (h slogTransitionHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }
func (h slogTransitionHandler) Handle(_ context.Context, r slog.Record) error {
	out := capturedLog{Message: r.Message}
	r.Attrs(func(a slog.Attr) bool {
		switch a.Key {
		case "edge":
			out.Edge = a.Value.String()
		case "agent_id":
			out.AgentID = a.Value.String()
		}
		return true
	})
	h.mu.Lock()
	defer h.mu.Unlock()
	*h.records = append(*h.records, out)
	return nil
}
func (h slogTransitionHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h slogTransitionHandler) WithGroup(string) slog.Handler      { return h }

// setupTransitionTriggerDB builds the minimum schema required to
// exercise the column transition trigger behaviour end-to-end. It
// includes column_agents with the new transition_trigger column
// (added by migration 011) so the tests reflect the post-s-1214
// schema. The same seed data (one admin user, one board, two
// columns, one task) is reused by every subtest in
// TestUpdateTaskFiresTransitionTrigger.
func setupTransitionTriggerDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

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
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
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
		is_public BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		description TEXT DEFAULT ''
	);
	CREATE TABLE board_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		access TEXT DEFAULT 'READ',
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
		transition_trigger TEXT NOT NULL DEFAULT 'none',
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
		published BOOLEAN DEFAULT 0,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		due_at DATETIME,
		agent_id TEXT,
		agent_prompt TEXT,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
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
	CREATE TABLE column_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		access TEXT DEFAULT 'READ',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'test-token', NULL)`); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'B1')`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`); err != nil {
		t.Fatalf("seed perm: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Todo', 'b1', 0)`); err != nil {
		t.Fatalf("seed c1: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, board_id, position) VALUES ('c2', 'Doing', 'b1', 1)`); err != nil {
		t.Fatalf("seed c2: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, position, created_by) VALUES ('t1', 'Walk the dog', 'c1', 1000, 'u1')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	// Disable auth so the handler tests don't have to thread a real
	// token cookie through every request — the trigger logic is
	// orthogonal to the auth check, which is exhaustively covered
	// by auth_test.go.
	if _, err := db.Exec(`INSERT INTO app_config (key, value) VALUES ('authEnabled', '0')`); err != nil {
		t.Fatalf("seed app_config: %v", err)
	}
	return db
}

// countEdgeLogs returns the number of captured transition-trigger
// records that carry the given edge value.
func countEdgeLogs(records []capturedLog, edge string) int {
	n := 0
	for _, r := range records {
		if r.Message == "Agent trigger column transition" && r.Edge == edge {
			n++
		}
	}
	return n
}

// drainLogs polls the captured records up to ~500ms waiting for
// the goroutine-spawned trigger log to land. Returns true once the
// expected counts are observed.
func drainLogs(snapshot func() []capturedLog, wantEnter, wantExit int) bool {
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		records := snapshot()
		if countEdgeLogs(records, "enter") >= wantEnter && countEdgeLogs(records, "exit") >= wantExit {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// TestSetColumnAgentTransitionTrigger exercises the SetColumnAgent
// handler's round-trip of the new transitionTrigger field. Each
// subtest writes a different value (or a missing field) and then
// reads the row back to verify the persisted value matches what
// the caller sent, plus that the default fallback works for
// pre-s-1214 callers that omit the field entirely.
func TestSetColumnAgentTransitionTrigger(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupTransitionTriggerDB(t)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/columns/:columnId/agent", handlers.SetColumnAgent(db))
	router.GET("/api/columns/:columnId/agent", handlers.GetColumnAgent(db))

	cases := []struct {
		name      string
		body      map[string]interface{}
		wantValue string
		columnID  string
	}{
		{
			name:      "explicit on_enter",
			body:      map[string]interface{}{"agentTypes": []string{"sre-bot"}, "transitionTrigger": "on_enter"},
			wantValue: "on_enter",
			columnID:  "c1",
		},
		{
			name:      "explicit on_exit",
			body:      map[string]interface{}{"agentTypes": []string{"sre-bot"}, "transitionTrigger": "on_exit"},
			wantValue: "on_exit",
			columnID:  "c1",
		},
		{
			name:      "explicit both",
			body:      map[string]interface{}{"agentTypes": []string{"sre-bot", "release-bot"}, "transitionTrigger": "both"},
			wantValue: "both",
			columnID:  "c1",
		},
		{
			name:      "missing field defaults to none",
			body:      map[string]interface{}{"agentTypes": []string{"sre-bot"}},
			wantValue: "none",
			columnID:  "c2",
		},
		{
			name:      "empty string defaults to none",
			body:      map[string]interface{}{"agentTypes": []string{"sre-bot"}, "transitionTrigger": ""},
			wantValue: "none",
			columnID:  "c2",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest("POST", "/api/columns/"+tc.columnID+"/agent", bytes.NewBuffer(body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("set status=%d body=%s", w.Code, w.Body.String())
			}

			// Read the persisted row directly so the test does not
			// depend on the GET handler shape.
			var trigger string
			if err := db.QueryRow("SELECT transition_trigger FROM column_agents WHERE column_id = ?", tc.columnID).Scan(&trigger); err != nil {
				t.Fatalf("read column_agents: %v", err)
			}
			if trigger != tc.wantValue {
				t.Errorf("persisted transition_trigger=%q want %q", trigger, tc.wantValue)
			}

			// And confirm the GET handler surfaces it.
			getReq, _ := http.NewRequest("GET", "/api/columns/"+tc.columnID+"/agent", nil)
			getReq.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
			getW := httptest.NewRecorder()
			router.ServeHTTP(getW, getReq)
			if getW.Code != http.StatusOK {
				t.Fatalf("get status=%d body=%s", getW.Code, getW.Body.String())
			}
			var resp map[string]interface{}
			if err := json.Unmarshal(getW.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal get response: %v", err)
			}
			if got := resp["transitionTrigger"]; got != tc.wantValue {
				t.Errorf("GET transitionTrigger=%v want %q", got, tc.wantValue)
			}
		})
	}
}

// TestSetColumnAgentRejectsBadTransitionTrigger locks the 400 path
// for transitionTrigger values outside the documented enum so a
// typo never silently degrades the auto-trigger to 'none'.
func TestSetColumnAgentRejectsBadTransitionTrigger(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := setupTransitionTriggerDB(t)

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/columns/:columnId/agent", handlers.SetColumnAgent(db))

	body, _ := json.Marshal(map[string]interface{}{
		"agentTypes":        []string{"sre-bot"},
		"transitionTrigger": "whenever",
	})
	req, _ := http.NewRequest("POST", "/api/columns/c1/agent", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed transitionTrigger, got %d body=%s", w.Code, w.Body.String())
	}
}

// TestUpdateTaskFiresTransitionTrigger covers the Definition of
// Done for s-1214: moving a task INTO a column that has opted-in
// to on_enter (or OUT OF a column that has opted-in to on_exit)
// must enqueue an Agent run for every bound agent_type. The
// handler logs each trigger via slog; we capture the default
// logger to assert the log was emitted without needing a live
// Agent runner.
//
// Subtests cover: on_enter fires once, on_exit fires once, both
// fires twice (once per edge), and 'none' / missing rows stay
// silent.
func TestUpdateTaskFiresTransitionTrigger(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cases := []struct {
		name          string
		fromTrigger   string // transition_trigger on the source column (c1)
		toTrigger     string // transition_trigger on the dest column (c2)
		fromAgents    string // JSON-encoded agent_types on c1
		toAgents      string // JSON-encoded agent_types on c2
		wantEnterLogs int
		wantExitLogs  int
	}{
		{
			name:          "on_enter on destination fires one enter",
			fromTrigger:   "none",
			toTrigger:     "on_enter",
			fromAgents:    "[\"sre-bot\"]",
			toAgents:      "[\"sre-bot\"]",
			wantEnterLogs: 1,
			wantExitLogs:  0,
		},
		{
			name:          "on_exit on source fires one exit",
			fromTrigger:   "on_exit",
			toTrigger:     "none",
			fromAgents:    "[\"sre-bot\"]",
			toAgents:      "[\"sre-bot\"]",
			wantEnterLogs: 0,
			wantExitLogs:  1,
		},
		{
			name:          "both columns opt-in to both edges fires two logs",
			fromTrigger:   "both",
			toTrigger:     "both",
			fromAgents:    "[\"sre-bot\"]",
			toAgents:      "[\"sre-bot\"]",
			wantEnterLogs: 1,
			wantExitLogs:  1,
		},
		{
			name:          "no opt-in stays silent",
			fromTrigger:   "none",
			toTrigger:     "none",
			fromAgents:    "[\"sre-bot\"]",
			toAgents:      "[\"sre-bot\"]",
			wantEnterLogs: 0,
			wantExitLogs:  0,
		},
		{
			name:          "no column_agents row stays silent",
			fromTrigger:   "",
			toTrigger:     "",
			fromAgents:    "",
			toAgents:      "",
			wantEnterLogs: 0,
			wantExitLogs:  0,
		},
		{
			name:          "multiple agent types fan out per edge",
			fromTrigger:   "on_exit",
			toTrigger:     "on_enter",
			fromAgents:    "[\"sre-bot\",\"release-bot\"]",
			toAgents:      "[\"sre-bot\",\"release-bot\"]",
			wantEnterLogs: 2,
			wantExitLogs:  2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Fresh DB per subtest so the column_agents seed does
			// not leak between cases.
			db := setupTransitionTriggerDB(t)
			if tc.fromAgents != "" {
				if _, err := db.Exec(`INSERT INTO column_agents (id, column_id, agent_types, transition_trigger) VALUES ('ca1', 'c1', ?, ?)`, tc.fromAgents, tc.fromTrigger); err != nil {
					t.Fatalf("seed c1 binding: %v", err)
				}
			}
			if tc.toAgents != "" {
				if _, err := db.Exec(`INSERT INTO column_agents (id, column_id, agent_types, transition_trigger) VALUES ('ca2', 'c2', ?, ?)`, tc.toAgents, tc.toTrigger); err != nil {
					t.Fatalf("seed c2 binding: %v", err)
				}
			}

			snapshot := captureTransitionLogs(t)

			router := gin.New()
			router.Use(handlers.RequireAuth(db))
			router.PUT("/api/tasks/:id", handlers.UpdateTask(db))

			body, _ := json.Marshal(map[string]interface{}{"columnId": "c2"})
			req, _ := http.NewRequest("PUT", "/api/tasks/t1", bytes.NewBuffer(body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("update status=%d body=%s", w.Code, w.Body.String())
			}

			// Drain the goroutine that emits the trigger log. The
			// handler runs it via `go func() { ... }` so the log
			// may not be flushed before the assertion fires.
			if !drainLogs(snapshot, tc.wantEnterLogs, tc.wantExitLogs) {
				records := snapshot()
				enter := countEdgeLogs(records, "enter")
				exits := countEdgeLogs(records, "exit")
				t.Fatalf("trigger log counts: enter=%d (want %d) exit=%d (want %d)", enter, tc.wantEnterLogs, exits, tc.wantExitLogs)
			}
		})
	}
}

// TestFireColumnTransitionsDirect exercises the service helper
// without going through the HTTP layer so the trigger-selection
// logic (edge matching, agent_types fan-out) is locked down even
// if the handler wiring changes.
func TestFireColumnTransitionsDirect(t *testing.T) {
	db := setupTransitionTriggerDB(t)
	svc := services.NewTaskService(db)

	// Seed a column_agents row with both edges opted-in and two
	// agent types so we can verify fan-out.
	if _, err := db.Exec(`INSERT INTO column_agents (id, column_id, agent_types, transition_trigger) VALUES ('ca1', 'c1', '["bot-a","bot-b"]', 'both')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	fired := svc.FireColumnTransitions(services.ColumnTransitionContext{
		TaskID:     "t1",
		TaskTitle:  "Walk the dog",
		FromColumn: "c1",
		ToColumn:   "",
	})
	if fired != 2 {
		t.Errorf("exit fan-out: fired=%d want 2", fired)
	}

	if _, err := db.Exec(`UPDATE column_agents SET transition_trigger = 'none' WHERE column_id = 'c1'`); err != nil {
		t.Fatalf("reset trigger: %v", err)
	}
	fired = svc.FireColumnTransitions(services.ColumnTransitionContext{
		TaskID:    "t1",
		TaskTitle: "Walk the dog",
		ToColumn:  "c1",
	})
	if fired != 0 {
		t.Errorf("none trigger should fire nothing, got fired=%d", fired)
	}
}

// TestNormalizeTransitionTrigger sanity-checks the enum-coercion
// helper used by every column-agent handler so a typo never
// silently downgrades to the documented 'none' default.
func TestNormalizeTransitionTrigger(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"on_enter", "on_enter"},
		{"on_exit", "on_exit"},
		{"both", "both"},
		{"none", "none"},
		{"", "none"},
		{"WHEN", "none"},
		{"on-enter", "none"},
	}
	for _, tc := range cases {
		if got := handlers.NormalizeTransitionTriggerForTest(tc.in); got != tc.want {
			t.Errorf("NormalizeTransitionTrigger(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
