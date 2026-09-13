package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

// setupWebhookEventsDB creates an in-memory SQLite database
// with the minimum schema RequireAuth needs: users, tokens, and
// app_config (the latter for the authEnabled flag). One seeded
// MEMBER user + one access token lets the test request
// authenticate without juggling the full kanban schema.
func setupWebhookEventsDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
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
		enabled INTEGER DEFAULT 1,
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
		FOREIGN KEY (user_id) REFERENCES users(id)
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, password, avatar, type, role, enabled) VALUES ('u1', 'alice', 'alice', '', '', 'HUMAN', 'MEMBER', 1)`,
	); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tokens (id, name, key, user_id) VALUES ('t1', 'default', 'events-token', 'u1')`,
	); err != nil {
		t.Fatalf("insert token: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO app_config (key, value) VALUES ('authEnabled', '1')`,
	); err != nil {
		t.Fatalf("insert app_config: %v", err)
	}
	return db
}

// webhookEventsRouter mounts the events endpoint behind the
// real RequireAuth middleware so the auth-failure test path is
// covered. Signature verification is disabled in tests to keep
// the per-request setup simple.
func webhookEventsRouter(db *sql.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/v1/webhooks/events",
		handlers.RequireAuth(db),
		handlers.WebhookEventCatalogue(db),
	)
	return r
}

// fetchCatalogue decodes the JSON response into a map for
// per-field assertions. We intentionally decode into
// map[string]any / []any rather than the typed struct so the
// tests catch accidental field renames — a renamed field would
// simply disappear from the decoded map and trip the existence
// check below.
func fetchCatalogue(t *testing.T, r *gin.Engine, auth bool) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", "/api/v1/webhooks/events", nil)
	if auth {
		req.Header.Set("Authorization", "Bearer events-token")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		return w, nil
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return w, resp
}

// TestWebhookEventCatalogue_RequireAuth asserts that the
// catalogue endpoint is mounted behind RequireAuth. Hitting it
// without a token must produce 401, not 200, so a regression
// that drops the middleware from main.go fails loudly here.
func TestWebhookEventCatalogue_RequireAuth(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWebhookEventsDB(t)
	defer db.Close()

	r := webhookEventsRouter(db)

	t.Run("missing token returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/events", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 without auth, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("invalid token returns 401", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/api/v1/webhooks/events", nil)
		req.Header.Set("Authorization", "Bearer not-a-real-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 with bad token, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("valid token returns 200", func(t *testing.T) {
		w, resp := fetchCatalogue(t, r, true)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 with valid token, got %d: %s", w.Code, w.Body.String())
		}
		if resp == nil {
			t.Fatalf("expected JSON body, got nil")
		}
	})
}

// TestWebhookEventCatalogue_Structure is the table-driven
// stability check. The catalogue is the contract between the
// backend and the §7.2 frontend picker; renaming a field,
// dropping an event, or shuffling the schema fragment shape
// silently breaks the UI. The table enumerates the 12 events
// from plan §3 and asserts:
//
//   - each event appears exactly once in the response;
//   - the entry has event / displayName / description /
//     payloadSchema / filters at the top level;
//   - payloadSchema carries the simplified JSON Schema
//     subset (type / required / properties) the task asks for;
//   - filter lists are a subset of the §3.2 catalogue.
//
// Adding a new event means appending a row here — the test
// will not pass until the catalogue and the table agree.
func TestWebhookEventCatalogue_Structure(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWebhookEventsDB(t)
	defer db.Close()

	r := webhookEventsRouter(db)
	_, resp := fetchCatalogue(t, r, true)
	if resp == nil {
		t.Fatalf("expected non-nil response body")
	}

	eventsRaw, ok := resp["events"].([]any)
	if !ok {
		t.Fatalf("expected events to be an array, got %T", resp["events"])
	}
	if got, want := len(eventsRaw), 12; got != want {
		t.Fatalf("expected %d events in catalogue (plan §3), got %d", want, got)
	}
	if count, ok := resp["count"].(float64); !ok || int(count) != len(eventsRaw) {
		t.Fatalf("expected count to equal len(events), got %v", count)
	}

	// Index entries by event name so the table-driven cases
	// can assert against a single lookup.
	byEvent := make(map[string]map[string]any, len(eventsRaw))
	for i, raw := range eventsRaw {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("events[%d] is not an object: %T", i, raw)
		}
		name, ok := entry["event"].(string)
		if !ok || name == "" {
			t.Fatalf("events[%d] missing non-empty event string", i)
		}
		if _, dup := byEvent[name]; dup {
			t.Fatalf("event %q appears more than once in the catalogue", name)
		}
		byEvent[name] = entry
	}

	// validFilters is the closed set of filter categories the
	// catalogue may reference. Defined inline so a typo in the
	// constant block above surfaces as a test failure rather
	// than a silent frontend picker bug.
	validFilters := map[string]struct{}{
		"boardIds":    {},
		"columnIds":   {},
		"priorities":  {},
		"assigneeIds": {},
	}

	// expectedFilters encodes the per-event filter
	// applicability from plan §3.2: every task.* event accepts
	// all four filters; column.* accepts only boardIds; the
	// two board.* events carry no filters at all.
	expectedFilters := map[string][]string{
		"task.created":    {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.updated":    {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.moved":      {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.completed":  {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.deleted":    {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.assigned":   {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"task.commented":  {"boardIds", "columnIds", "priorities", "assigneeIds"},
		"column.created":  {"boardIds"},
		"column.updated":  {"boardIds"},
		"column.deleted":  {"boardIds"},
		"board.created":   {},
		"board.updated":   {},
	}

	cases := []struct {
		event       string
		displayName string
	}{
		{"task.created", "任务创建"},
		{"task.updated", "任务更新"},
		{"task.moved", "任务移动"},
		{"task.completed", "任务完成"},
		{"task.deleted", "任务删除"},
		{"task.assigned", "任务分配"},
		{"task.commented", "任务评论"},
		{"column.created", "列创建"},
		{"column.updated", "列更新"},
		{"column.deleted", "列删除"},
		{"board.created", "看板创建"},
		{"board.updated", "看板更新"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.event, func(t *testing.T) {
			entry, ok := byEvent[tc.event]
			if !ok {
				t.Fatalf("event %q missing from catalogue", tc.event)
			}

			// Top-level fields the picker relies on. The
			// task specifically calls out type +
			// description — type refers to the
			// payloadSchema.type, description is the
			// human-readable trigger description.
			if name, _ := entry["displayName"].(string); name != tc.displayName {
				t.Errorf("displayName: want %q, got %q", tc.displayName, name)
			}
			if desc, _ := entry["description"].(string); desc == "" {
				t.Errorf("description must be non-empty")
			}

			schema, ok := entry["payloadSchema"].(map[string]any)
			if !ok {
				t.Fatalf("payloadSchema must be an object, got %T", entry["payloadSchema"])
			}
			if typ, _ := schema["type"].(string); typ != "object" {
				t.Errorf("payloadSchema.type: want %q, got %q", "object", typ)
			}
			if _, ok := schema["required"]; !ok {
				t.Errorf("payloadSchema must include a required array")
			}
			if _, ok := schema["properties"]; !ok {
				t.Errorf("payloadSchema must include a properties object")
			}

			filters, ok := entry["filters"].([]any)
			if !ok {
				t.Fatalf("filters must be an array, got %T", entry["filters"])
			}
			want := expectedFilters[tc.event]
			got := make([]string, 0, len(filters))
			for _, f := range filters {
				name, ok := f.(string)
				if !ok {
					t.Fatalf("filter entry must be a string, got %T", f)
				}
				if _, valid := validFilters[name]; !valid {
					t.Errorf("filter %q is not in the §3.2 catalogue", name)
				}
				got = append(got, name)
			}
			if len(got) != len(want) {
				t.Errorf("filters count: want %d (%v), got %d (%v)", len(want), want, len(got), got)
			}
		})
	}
}

// TestWebhookEventCatalogue_SortedOrder asserts the wire order
// is sorted by event name. The picker renders rows in the
// order they arrive; a non-deterministic order would surface
// as flickering UI on each catalogue refresh.
func TestWebhookEventCatalogue_SortedOrder(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWebhookEventsDB(t)
	defer db.Close()

	r := webhookEventsRouter(db)
	_, resp := fetchCatalogue(t, r, true)
	if resp == nil {
		t.Fatalf("expected non-nil response body")
	}
	eventsRaw, ok := resp["events"].([]any)
	if !ok {
		t.Fatalf("expected events to be an array, got %T", resp["events"])
	}

	prev := ""
	for i, raw := range eventsRaw {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("events[%d] is not an object", i)
		}
		name, _ := entry["event"].(string)
		if name == "" {
			t.Fatalf("events[%d] missing event name", i)
		}
		if name < prev {
			t.Errorf("events not sorted at index %d: %q < %q", i, name, prev)
		}
		prev = name
	}
}

// TestWebhookEventCatalogue_TaskSchemaSpotCheck picks one event
// (task.moved) and inspects its payloadSchema to make sure the
// required array contains fromColumnId / toColumnId and that
// those fields are typed as strings. Guards against accidental
// edits to the per-event schema fragments.
func TestWebhookEventCatalogue_TaskSchemaSpotCheck(t *testing.T) {
	handlers.ResetTokenCacheForTest()
	db := setupWebhookEventsDB(t)
	defer db.Close()

	r := webhookEventsRouter(db)
	_, resp := fetchCatalogue(t, r, true)
	if resp == nil {
		t.Fatalf("expected non-nil response body")
	}
	eventsRaw := resp["events"].([]any)
	var moved map[string]any
	for _, raw := range eventsRaw {
		entry := raw.(map[string]any)
		if entry["event"] == "task.moved" {
			moved = entry
			break
		}
	}
	if moved == nil {
		t.Fatalf("task.moved not found in catalogue")
	}
	schema := moved["payloadSchema"].(map[string]any)
	required := schema["required"].([]any)
	wantRequired := map[string]bool{"task": false, "fromColumnId": false, "toColumnId": false}
	for _, r := range required {
		s := r.(string)
		if _, ok := wantRequired[s]; ok {
			wantRequired[s] = true
		}
	}
	for name, found := range wantRequired {
		if !found {
			t.Errorf("task.moved payloadSchema.required missing %q", name)
		}
	}

	properties := schema["properties"].(map[string]any)
	for _, field := range []string{"fromColumnId", "toColumnId"} {
		prop, ok := properties[field].(map[string]any)
		if !ok {
			t.Fatalf("task.moved properties.%s missing", field)
		}
		if prop["type"] != "string" {
			t.Errorf("task.moved properties.%s.type: want string, got %v", field, prop["type"])
		}
	}
}
