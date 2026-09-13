package oauth_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/handlers"
	"open-kanban/internal/oauth"
)

// The tests in this file cover the GET /oauth/device/agents endpoint
// added by s-1112.4 (plan §4.1.3). The endpoint re-uses the same
// payload as the `available_agents` slice embedded in
// /oauth/device/lookup, but as its own GET so the device
// authorization page can re-fetch the list after the human changes
// scope or filter without round-tripping through lookup.
//
// Visibility contract (plan §4.1.2 + §4.1.3):
//   - ADMIN callers see every enabled AGENT user.
//   - MEMBER / VIEWER callers see enabled AGENTs whose role is not
//     ADMIN, so a human approver can only delegate to Agents that
//     match their own authority tier.
//   - Disabled AGENTs are excluded regardless of caller role.
//   - HUMAN users are excluded regardless of caller role.
//   - Unauthenticated requests are rejected at the route layer by
//     handlers.RequireAuth.

func newDeviceAgentsServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.GET("/oauth/device/agents", handlers.RequireAuth(db), oauth.DeviceAgentsHandler(db))
	return r
}

// seedAgentWithTimestamps inserts an AGENT row with explicit created_at
// timestamps so the ORDER BY clause in the SQL produces a stable
// ordering regardless of insert timing. Without this the tests flake
// on fast machines because every row shares the same second.
func seedAgentWithTimestamps(t *testing.T, db *sql.DB, id, nickname, role string, enabled bool, createdAt time.Time) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, '', 'AGENT', ?, ?, ?, ?)`,
		id, id, nickname, role, enabled, createdAt, createdAt,
	); err != nil {
		t.Fatalf("seed agent %s: %v", id, err)
	}
}

// deviceAgentsRequest issues a GET /oauth/device/agents as the supplied
// caller. Returns the decoded JSON body so callers can introspect the
// "agents" array without repeating boilerplate.
func deviceAgentsRequest(t *testing.T, r *gin.Engine, db *sql.DB, callerID, callerRole, callerType string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/oauth/device/agents", nil)
	setAgentListUser(req, db, callerID, callerRole, callerType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var body map[string]interface{}
	if w.Body.Len() > 0 {
		_ = json.Unmarshal(w.Body.Bytes(), &body)
	}
	return w.Code, body
}

// setAgentListUser seeds a user row plus a token cookie so the
// RequireAuth middleware resolves them. callerType drives the AGENT vs
// HUMAN column so the suite can also exercise AGENT-typed callers.
func setAgentListUser(req *http.Request, db *sql.DB, userID, role, userType string) {
	if userType == "" {
		userType = "HUMAN"
	}
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled)
		 VALUES (?, ?, ?, '', ?, ?, 1)`,
		userID, userID, userID, userType, role,
	); err != nil {
		panic(err)
	}
	key := "test-token-" + userID
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO tokens (id, name, key, user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"tok-"+userID, "test", key, userID, time.Now(), time.Now(),
	); err != nil {
		panic(err)
	}
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: key})
}

// agentIDsFromResponse extracts the `id` field from each entry of the
// "agents" array, returning an empty slice when the key is absent (so
// callers can assert "MEMBER sees no Agents" without nil-checking).
func agentIDsFromResponse(body map[string]interface{}) []string {
	raw, ok := body["agents"].([]interface{})
	if !ok {
		return nil
	}
	ids := make([]string, 0, len(raw))
	for _, entry := range raw {
		if m, ok := entry.(map[string]interface{}); ok {
			if id, ok := m["id"].(string); ok {
				ids = append(ids, id)
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// 1. Unauthenticated request is rejected by RequireAuth before the
// handler runs. (plan §4.1.3: "Auth: handlers.RequireAuth(db)")
func TestDeviceAgents_UnauthenticatedReturns401(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	r := newDeviceAgentsServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/agents", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

// 2. ADMIN caller sees every enabled AGENT row, regardless of the
// Agent's role. Pins the happy path documented in plan §4.1.2 + §4.1.3.
// (plan §4.1.6 #13 - admin branch)
func TestDeviceAgents_AdminSeesAllEnabledAgents(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true, now.Add(-3*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-member-role", "Member Agent", "MEMBER", true, now.Add(-2*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "admin-1", "ADMIN", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromResponse(body)
	want := []string{"agent-admin-role", "agent-member-role", "agent-viewer-role"}
	if len(ids) != len(want) {
		t.Fatalf("expected %d agents, got %d (%v)", len(want), len(ids), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("expected sorted id %q at index %d, got %q", want[i], i, ids[i])
		}
	}
}

// 3. ADMIN caller never sees disabled Agents or HUMAN users — the
// enabled/disabled and type='AGENT' filters apply uniformly.
func TestDeviceAgents_AdminFiltersDisabledAndHumans(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-on", "On", "ADMIN", true, now.Add(-3*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-off", "Off", "MEMBER", false, now.Add(-2*time.Hour))
	// Insert a HUMAN row directly so we can confirm it never surfaces.
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at)
		 VALUES ('user-human', 'u', 'Human', '', 'HUMAN', 'ADMIN', 1, ?)`,
		now.Add(-1*time.Hour),
	); err != nil {
		t.Fatalf("seed human: %v", err)
	}
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "admin-1", "ADMIN", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromResponse(body)
	if len(ids) != 1 || ids[0] != "agent-on" {
		t.Errorf("expected only enabled agent [agent-on], got %v", ids)
	}
}

// 4. MEMBER caller cannot see ADMIN-role Agents — only the MEMBER
// and VIEWER Agents surface. (plan §4.1.2 + §4.1.3 visibility rule)
func TestDeviceAgents_MemberHidesAdminRoleAgents(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true, now.Add(-3*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-member-role", "Member Agent", "MEMBER", true, now.Add(-2*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "member-1", "MEMBER", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromResponse(body)
	want := []string{"agent-member-role", "agent-viewer-role"}
	if len(ids) != len(want) {
		t.Fatalf("expected %d agents, got %d (%v)", len(want), len(ids), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("expected sorted id %q at index %d, got %q", want[i], i, ids[i])
		}
	}
}

// 5. VIEWER caller sees the same filtered list as MEMBER — only
// non-ADMIN Agents are visible.
func TestDeviceAgents_ViewerHidesAdminRoleAgents(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true, now.Add(-2*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "viewer-1", "VIEWER", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromResponse(body)
	if len(ids) != 1 || ids[0] != "agent-viewer-role" {
		t.Errorf("expected only viewer-role agent, got %v", ids)
	}
}

// 6. Disabled Agents never surface even when the visibility rule
// would otherwise allow them. Catches the regression where the role
// filter accidentally runs before the enabled filter.
func TestDeviceAgents_FiltersDisabledRegardlessOfRole(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-disabled-member", "Disabled Member", "MEMBER", false, now.Add(-2*time.Hour))
	seedAgentWithTimestamps(t, db, "agent-enabled-member", "Enabled Member", "MEMBER", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "admin-1", "ADMIN", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromResponse(body)
	if len(ids) != 1 || ids[0] != "agent-enabled-member" {
		t.Errorf("expected only enabled member agent, got %v", ids)
	}
}

// 7. Empty result set serialises as `"agents": []`, not `null`, so the
// frontend can iterate the field unconditionally. Matches the CLAUDE.md
// guidance "Prefer returning empty arrays `[]` over `null` for list
// responses".
func TestDeviceAgents_EmptyResultIsArrayNotNull(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	// Seed a single ADMIN-role Agent and a MEMBER caller. The MEMBER
	// should see an empty list because the only Agent is gated by role.
	seedAgentWithTimestamps(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "member-1", "MEMBER", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	// Re-marshal the body so we can assert the JSON literal includes
	// the empty array, not a null. json.Unmarshal folds both into a
	// nil []interface{} which can't be distinguished on its own.
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !contains(string(raw), `"agents":[]`) {
		t.Errorf("expected empty array literal in JSON, got %s", raw)
	}
}

// 8. Payload mirrors the `available_agents` slice from
// /oauth/device/lookup: each entry carries id, nickname, username,
// and role. No extra fields leak through so the frontend can reuse the
// existing rendering path unchanged. (task description: "Same payload
// as available_agents[] in lookup.")
func TestDeviceAgents_PayloadShapeMatchesLookup(t *testing.T) {
	db := setupTokenDB(t)
	defer db.Close()
	now := time.Now()
	seedAgentWithTimestamps(t, db, "agent-alpha", "Alpha", "ADMIN", true, now.Add(-1*time.Hour))
	r := newDeviceAgentsServer(t, db)

	code, body := deviceAgentsRequest(t, r, db, "admin-1", "ADMIN", "HUMAN")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	raw, ok := body["agents"].([]interface{})
	if !ok || len(raw) != 1 {
		t.Fatalf("expected exactly one agent, got %v", body["agents"])
	}
	entry, ok := raw[0].(map[string]interface{})
	if !ok {
		t.Fatalf("expected map entry, got %T", raw[0])
	}
	wantKeys := map[string]string{
		"id":       "agent-alpha",
		"nickname": "Alpha",
		"username": "agent-alpha",
		"role":     "ADMIN",
	}
	for key, expected := range wantKeys {
		if got, _ := entry[key].(string); got != expected {
			t.Errorf("entry[%q] = %q, want %q", key, got, expected)
		}
	}
	// Explicitly forbid keys the frontend does not expect from the
	// lookup payload so the symmetry stays in place if a future PR
	// adds metadata.
	for _, forbidden := range []string{"enabled", "type", "avatar", "createdAt"} {
		if _, present := entry[forbidden]; present {
			t.Errorf("entry unexpectedly contains %q", forbidden)
		}
	}
}

// contains is a tiny strings.Contains alias so the empty-array test
// doesn't pull in a strings import for one call.
func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
