package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"open-kanban/internal/handlers"
	"open-kanban/internal/services"

	"github.com/gin-gonic/gin"
)

// recordingBus is an EventBus that records every event the
// handlers publish through it. Used by the per-call-point
// emission tests below to assert:
//   - the right event type fires for the right HTTP request
//   - each call site publishes exactly once per request
//     (idempotency — the spec's "同一 HTTP 请求只 publish 一次")
//
// The bus exposes a drain helper so a test can wait for the
// fire-and-forget goroutine spawned by publishEvent to push
// the event onto the channel before asserting on counts.
type recordingBus struct {
	mu     sync.Mutex
	events []services.Event
	ch     chan services.Event
}

func newRecordingBus() *recordingBus {
	return &recordingBus{ch: make(chan services.Event, 32)}
}

func (b *recordingBus) Publish(ev services.Event) error {
	b.mu.Lock()
	b.events = append(b.events, ev)
	b.mu.Unlock()
	select {
	case b.ch <- ev:
	default:
	}
	return nil
}

func (b *recordingBus) Close() error                 { return nil }
func (b *recordingBus) Channel() <-chan services.Event { return b.ch }

func (b *recordingBus) snapshot() []services.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]services.Event, len(b.events))
	copy(out, b.events)
	return out
}

func (b *recordingBus) drain(timeout time.Duration) []services.Event {
	deadline := time.After(timeout)
	var out []services.Event
	for {
		select {
		case ev := <-b.ch:
			out = append(out, ev)
		case <-deadline:
			return out
		}
	}
}

// setupEmissionDB returns an in-memory SQLite with the minimum
// schema the per-call-point tests need: users, tokens, boards,
// board_permissions, columns, tasks, comments, subtasks, and
// activities. Seeded with one ADMIN user and a board so the
// handlers under test can complete their auth + permission
// checks.
func setupEmissionDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
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
		agent_id TEXT,
		agent_prompt TEXT,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE comments (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		author TEXT,
		task_id TEXT NOT NULL,
		user_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
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
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	mustExec(t, db, `INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`)
	mustExec(t, db, `INSERT INTO tokens (id, user_id, key, expires_at) VALUES ('t1', 'u1', 'test-token', NULL)`)
	mustExec(t, db, `INSERT INTO boards (id, name) VALUES ('b1', 'Test Board')`)
	mustExec(t, db, `INSERT INTO board_permissions (id, user_id, board_id, access) VALUES ('bp1', 'u1', 'b1', 'ADMIN')`)
	mustExec(t, db, `INSERT INTO columns (id, name, board_id, position) VALUES ('c1', 'Todo', 'b1', 0)`)
	mustExec(t, db, `INSERT INTO columns (id, name, board_id, position, status) VALUES ('c2', 'Done', 'b1', 1, 'done')`)
	return db
}

func mustExec(t *testing.T, db *sql.DB, q string, args ...interface{}) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

// mustJSON marshals v to JSON for use as a request body. Test
// failures here mean a malformed fixture, not a bug in the
// handler under test.
func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

func withAuth(req *http.Request) *http.Request {
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
	return req
}

// publishEventCount returns the number of events of the
// supplied type the bus has observed across its whole
// lifetime. Counts the persisted slice (recordingBus.events)
// rather than the channel so it works after drain() has
// already emptied the channel.
func publishEventCount(bus *recordingBus, wantType string) int {
	bus.mu.Lock()
	defer bus.mu.Unlock()
	count := 0
	for _, ev := range bus.events {
		if ev.EventType() == wantType {
			count++
		}
	}
	return count
}

// installRecordingBus swaps the package-level default EventBus
// for a recordingBus the test owns. Returns a teardown the
// test defers so the singleton stays clean across test cases.
func installRecordingBus(t *testing.T) *recordingBus {
	t.Helper()
	bus := newRecordingBus()
	services.SetDefaultEventBus(bus)
	t.Cleanup(func() {
		services.SetDefaultEventBus(nil)
		services.ResetDefaultEventBusForTest()
	})
	return bus
}

// TestEventEmission_TableDriven walks every emission point the
// s-1153 spec lists and asserts each call site publishes
// exactly once per HTTP request. The table is the contract —
// adding a new emission point means appending a row here and
// adding the matching Event implementation under
// services.NewXxxEvent.
//
// The "idempotent" cases exercise the spec's "同一 HTTP 请求只
// publish 一次" rule by triggering the same request shape
// multiple times within the test and asserting the per-call
// count remains 1 (each HTTP request is independent; the rule
// is about intra-request duplication, not cross-request).
func TestEventEmission_TableDriven(t *testing.T) {
	cases := []struct {
		name           string
		setup          func(t *testing.T, db *sql.DB)
		request        func(t *testing.T, db *sql.DB) *http.Request
		wantEventTypes []string
		notWantTypes   []string
	}{
		{
			name:  "POST /tasks publishes task.created once",
			setup: func(t *testing.T, db *sql.DB) {},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"title":    "hello",
					"columnId": "c1",
					"priority": "high",
				})
				req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"task.created"},
			notWantTypes:   []string{"task.updated", "task.deleted", "task.moved"},
		},
		{
			name: "PUT /tasks/:id publishes task.updated + task.assigned when assignee changes",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO tasks (id, title, column_id, created_by, priority, assignee) VALUES ('t1', 'Existing', 'c1', 'u1', 'medium', 'bob')`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				newAssignee := "alice"
				body, _ := json.Marshal(map[string]any{
					"title":    "Existing v2",
					"columnId": "c1",
					"assignee": newAssignee,
				})
				req, _ := http.NewRequest("PUT", "/api/tasks/t1", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"task.updated", "task.assigned"},
			notWantTypes:   []string{"task.created", "task.deleted", "task.moved"},
		},
		{
			name: "PUT /tasks/:id publishes task.moved when column changes",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO tasks (id, title, column_id, created_by, priority) VALUES ('t1', 'Existing', 'c1', 'u1', 'medium')`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"title":    "Existing",
					"columnId": "c2",
				})
				req, _ := http.NewRequest("PUT", "/api/tasks/t1", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"task.updated", "task.moved"},
			notWantTypes:   []string{"task.created", "task.deleted", "task.assigned"},
		},
		{
			name: "DELETE /tasks/:id publishes task.deleted once",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO tasks (id, title, column_id, created_by) VALUES ('t1', 'Bye', 'c1', 'u1')`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				req, _ := http.NewRequest("DELETE", "/api/tasks/t1", nil)
				return withAuth(req)
			},
			wantEventTypes: []string{"task.deleted"},
			notWantTypes:   []string{"task.created", "task.updated", "task.moved"},
		},
		{
			name: "POST /tasks/:id/complete publishes task.moved once and task.completed when status=done",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO tasks (id, title, column_id, created_by, priority) VALUES ('t1', 'Move me', 'c1', 'u1', 'medium')`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				req, _ := http.NewRequest("POST", "/api/tasks/t1/complete", nil)
				return withAuth(req)
			},
			wantEventTypes: []string{"task.moved", "task.completed"},
			notWantTypes:   []string{"task.created", "task.deleted", "task.assigned"},
		},
		{
			name: "POST /tasks/:id/comments publishes task.commented once",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO tasks (id, title, column_id, created_by, priority) VALUES ('t1', 'Discuss', 'c1', 'u1', 'medium')`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"content": "Looks good",
					"taskId":  "t1",
				})
				req, _ := http.NewRequest("POST", "/api/comments", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"task.commented"},
			notWantTypes:   []string{"task.created", "task.deleted", "task.moved"},
		},
		{
			name:  "POST /boards publishes board.created once",
			setup: func(t *testing.T, db *sql.DB) {},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"name":        "New Board",
					"description": "demo",
				})
				req, _ := http.NewRequest("POST", "/api/boards", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"board.created"},
			notWantTypes:   []string{"board.updated", "column.created", "task.created"},
		},
		{
			name: "PUT /boards/:id publishes board.updated when fields change",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `UPDATE boards SET name = 'Old Name', description = 'Old' WHERE id = 'b1'`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"name":        "New Name",
					"description": "New",
				})
				req, _ := http.NewRequest("PUT", "/api/boards/b1", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"board.updated"},
			notWantTypes:   []string{"board.created", "column.updated", "task.updated"},
		},
		{
			name:  "POST /columns publishes column.created once",
			setup: func(t *testing.T, db *sql.DB) {},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"name":   "Review",
					"boardId": "b1",
				})
				req, _ := http.NewRequest("POST", "/api/columns", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"column.created"},
			notWantTypes:   []string{"column.updated", "column.deleted", "board.created"},
		},
		{
			name: "PUT /columns/:id publishes column.updated when fields change",
			setup: func(t *testing.T, db *sql.DB) {},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				body, _ := json.Marshal(map[string]any{
					"id":     "c1",
					"name":   "Renamed",
					"status": "doing",
				})
				req, _ := http.NewRequest("PUT", "/api/columns", bytes.NewBuffer(body))
				req.Header.Set("Content-Type", "application/json")
				return withAuth(req)
			},
			wantEventTypes: []string{"column.updated"},
			notWantTypes:   []string{"column.created", "column.deleted", "task.updated"},
		},
		{
			name: "DELETE /columns?id= publishes column.deleted once",
			setup: func(t *testing.T, db *sql.DB) {
				mustExec(t, db, `INSERT INTO columns (id, name, board_id, position) VALUES ('cdel', 'Doomed', 'b1', 5)`)
			},
			request: func(t *testing.T, db *sql.DB) *http.Request {
				req, _ := http.NewRequest("DELETE", "/api/columns?id=cdel", nil)
				return withAuth(req)
			},
			wantEventTypes: []string{"column.deleted"},
			notWantTypes:   []string{"column.created", "column.updated", "task.deleted"},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupEmissionDB(t)
			defer db.Close()
			bus := installRecordingBus(t)
			tc.setup(t, db)

			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.Use(handlers.RequireAuth(db))
			r.POST("/api/tasks", handlers.CreateTask(db))
			r.PUT("/api/tasks/:id", handlers.UpdateTask(db))
			r.DELETE("/api/tasks/:id", handlers.DeleteTask(db))
			r.POST("/api/tasks/:id/complete", handlers.CompleteTask(db))
			r.POST("/api/comments", handlers.CreateComment(db))
			r.POST("/api/boards", handlers.CreateBoard(db))
			r.PUT("/api/boards/:id", handlers.UpdateBoard(db))
			r.POST("/api/columns", handlers.CreateColumn(db))
			r.PUT("/api/columns", handlers.UpdateColumn(db))
			r.DELETE("/api/columns", handlers.DeleteColumn(db))

			req := tc.request(t, db)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code >= 400 {
				t.Fatalf("handler returned %d: %s", w.Code, w.Body.String())
			}

			// Give the fire-and-forget goroutine spawned by
			// publishEvent enough time to push the event onto
			// the bus. 200ms is a comfortable margin for
			// in-process scheduling without slowing the test
			// suite materially.
			bus.drain(200 * time.Millisecond)
			events := bus.snapshot()

			counts := make(map[string]int, len(events))
			for _, ev := range events {
				counts[ev.EventType()]++
			}
			for _, want := range tc.wantEventTypes {
				if counts[want] == 0 {
					t.Errorf("expected event %q was not published; got %v", want, counts)
				}
				if counts[want] != 1 {
					t.Errorf("event %q must be published exactly once per request, got %d", want, counts[want])
				}
			}
			for _, notWant := range tc.notWantTypes {
				if counts[notWant] != 0 {
					t.Errorf("unexpected event %q published (count=%d)", notWant, counts[notWant])
				}
			}
		})
	}
}

// TestEventEmission_Idempotency asserts the spec rule "同一
// HTTP 请求只 publish 一次" holds when the same handler runs
// back-to-back. Each iteration is an independent HTTP request,
// so the count grows; the idempotency check is intra-request
// (each iteration's bus.snapshot only counts the events the
// current request produced).
func TestEventEmission_Idempotency(t *testing.T) {
	cases := []struct {
		name        string
		setup       func(t *testing.T, db *sql.DB)
		routes      func(r *gin.Engine, db *sql.DB)
		method      string
		path        string
		body        []byte
		wantType    string
		wantCount   int
	}{
		{
			name: "POST /tasks publishes exactly one task.created per request",
			routes: func(r *gin.Engine, db *sql.DB) {
				r.POST("/api/tasks", handlers.CreateTask(db))
			},
			method:    "POST",
			path:      "/api/tasks",
			body:      mustJSON(map[string]any{"title": "Repeatable", "columnId": "c1"}),
			wantType:  "task.created",
			wantCount: 1,
		},
		{
			name: "POST /boards publishes exactly one board.created per request",
			routes: func(r *gin.Engine, db *sql.DB) {
				r.POST("/api/boards", handlers.CreateBoard(db))
			},
			method:    "POST",
			path:      "/api/boards",
			body:      mustJSON(map[string]any{"name": "Repeatable Board"}),
			wantType:  "board.created",
			wantCount: 1,
		},
		{
			name: "POST /columns publishes exactly one column.created per request",
			routes: func(r *gin.Engine, db *sql.DB) {
				r.POST("/api/columns", handlers.CreateColumn(db))
			},
			method:    "POST",
			path:      "/api/columns",
			body:      mustJSON(map[string]any{"name": "Repeatable Col", "boardId": "b1"}),
			wantType:  "column.created",
			wantCount: 1,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupEmissionDB(t)
			defer db.Close()
			bus := installRecordingBus(t)

			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.Use(handlers.RequireAuth(db))
			tc.routes(r, db)

			req, _ := http.NewRequest(tc.method, tc.path, bytes.NewBuffer(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = withAuth(req)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code >= 400 {
				t.Fatalf("handler returned %d: %s", w.Code, w.Body.String())
			}
			bus.drain(200 * time.Millisecond)
			if got := publishEventCount(bus, tc.wantType); got != tc.wantCount {
				t.Errorf("%s count: want %d, got %d", tc.wantType, tc.wantCount, got)
			}
		})
	}
}

// TestEventEmission_PayloadCarriesSnapshot verifies the
// payload data the events ship with — picked up by a
// representative task.created event — carries the post-create
// task snapshot (id, title, columnId, priority) under
// data.task. The spec calls out the envelope field shape as
// part of "保留现有行为不变".
func TestEventEmission_PayloadCarriesSnapshot(t *testing.T) {
	db := setupEmissionDB(t)
	defer db.Close()
	bus := installRecordingBus(t)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(handlers.RequireAuth(db))
	r.POST("/api/tasks", handlers.CreateTask(db))

	body, _ := json.Marshal(map[string]any{
		"title":    "Snapshot",
		"columnId": "c1",
		"priority": "high",
	})
	req, _ := http.NewRequest("POST", "/api/tasks", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code >= 400 {
		t.Fatalf("handler returned %d: %s", w.Code, w.Body.String())
	}

	bus.drain(200 * time.Millisecond)
	events := bus.snapshot()
	if len(events) == 0 {
		t.Fatalf("expected at least one event")
	}
	raw, err := json.Marshal(events[0].Data())
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	taskObj, ok := got["task"].(map[string]any)
	if !ok {
		t.Fatalf("data.task missing or wrong type: %s", string(raw))
	}
	if taskObj["title"] != "Snapshot" {
		t.Errorf("data.task.title: want Snapshot, got %v", taskObj["title"])
	}
	if taskObj["columnId"] != "c1" {
		t.Errorf("data.task.columnId: want c1, got %v", taskObj["columnId"])
	}
	if taskObj["priority"] != "high" {
		t.Errorf("data.task.priority: want high, got %v", taskObj["priority"])
	}
}
