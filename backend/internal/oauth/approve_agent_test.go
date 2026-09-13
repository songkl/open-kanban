package oauth_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/oauth"
)

// The tests in this file cover the fifteen scenarios enumerated in
// devDoc/DEVICE_AUTH_AGENT_SELECTION_PLAN_2026-09-13.md §4.1.6 — the
// device-flow agent-binding approval flow that lets a human approver
// delegate a device code to a specific Agent identity.
//
// Scenarios #4 / #5 / #6 / #7 assert the explicit-agent_id rejection
// paths that s-1112.2 wired into DeviceApproveHandler via the
// LookupAgent helper (plan §4.1.1). Scenarios #1 / #2 / #3 / #8 /
// #14 / #15 stay green by exercising only enabled AGENT rows with
// ADMIN approvers. Scenarios #9 / #11 / #12 / #13 still cover the
// not-yet-wired `oauth_device_require_agent_selection` flag and the
// lookup-side agent-selection affordances that s-1112.3 / s-1112.5
// will tighten.

func setupAgentApprovalDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupApproveDB(t)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS activity_log (
		id TEXT PRIMARY KEY,
		actor_id TEXT,
		target_id TEXT,
		action TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatalf("activity_log schema: %v", err)
	}
	return db
}

func seedAgentWithRole(t *testing.T, db *sql.DB, id, nickname, role string, enabled bool) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled)
		 VALUES (?, ?, ?, '', 'AGENT', ?, ?)`,
		id, id, nickname, role, enabled,
	); err != nil {
		t.Fatalf("seed agent %s: %v", id, err)
	}
}

func seedHumanWithRole(t *testing.T, db *sql.DB, id, nickname, role string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled)
		 VALUES (?, ?, ?, '', 'HUMAN', ?, 1)`,
		id, id, nickname, role,
	); err != nil {
		t.Fatalf("seed human %s: %v", id, err)
	}
}

func postApproveAs(t *testing.T, r *gin.Engine, db *sql.DB, approverID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(req, db, approverID, "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func lookupDevice(t *testing.T, r *gin.Engine, code string) map[string]interface{} {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?code="+code, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("lookup %s: expected 200, got %d: %s", code, w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode lookup: %v", err)
	}
	return resp
}

// 1. Approve with agent_id set — row bound to that Agent. (plan §4.1.6 #1)
func TestApproveAgentScenario1_AgentIDSetBindsToAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0001", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-alpha", "Alpha", "ADMIN", true)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0001","decision":"approve","agentId":"agent-alpha"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'SCEN-0001'`,
	).Scan(&bound); err != nil {
		t.Fatalf("query: %v", err)
	}
	if bound != "agent-alpha" {
		t.Errorf("expected bound agent-alpha, got %q", bound)
	}
}

// 2. Approve with agent_id empty and global config empty — bound to
// human approver (legacy behaviour). (plan §4.1.6 #2)
func TestApproveAgentScenario2_EmptyAgentAndEmptyGlobalBindsToApprover(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0002", "kanban:read", time.Hour)
	if err := oauth.SetConfig(db, "oauth_device_agent_id", ""); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0002","decision":"approve"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'SCEN-0002'`,
	).Scan(&bound); err != nil {
		t.Fatalf("query: %v", err)
	}
	if bound != "user-1" {
		t.Errorf("expected bound user-1, got %q", bound)
	}
}

// 3. Approve with agent_id empty and global config set — bound to
// configured Agent. (plan §4.1.6 #3)
func TestApproveAgentScenario3_EmptyAgentGlobalSetBindsToConfiguredAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0003", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-global", "Global", "ADMIN", true)
	if err := oauth.SetConfig(db, "oauth_device_agent_id", "agent-global"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0003","decision":"approve"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'SCEN-0003'`,
	).Scan(&bound); err != nil {
		t.Fatalf("query: %v", err)
	}
	if bound != "agent-global" {
		t.Errorf("expected bound agent-global, got %q", bound)
	}
}

// 4. Approve with unknown agent_id. The plan §4.1.1 mandates a 400
// invalid_request; LookupAgent now rejects unknown ids at the handler
// boundary, leaving the device_code row untouched so the approver can
// resubmit without an explicit agent_id. (plan §4.1.6 #4)
func TestApproveAgentScenario4_UnknownAgentReturns400(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0004", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0004","decision":"approve","agentId":"ghost-agent"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid_request, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error"] != "invalid_request" {
		t.Errorf("expected error=invalid_request, got %v", resp["error"])
	}
	var status string
	if err := db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'SCEN-0004'`,
	).Scan(&status); err != nil {
		t.Fatalf("query: %v", err)
	}
	if status != "pending" {
		t.Errorf("expected device code still pending, got %q", status)
	}
}

// 5. Approve with agent_id pointing at a disabled Agent. Plan §4.1.1
// wants 400 invalid_request; LookupAgent rejects disabled rows. (plan
// §4.1.6 #5)
func TestApproveAgentScenario5_DisabledAgentReturns400(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0005", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-disabled", "Disabled", "ADMIN", false)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0005","decision":"approve","agentId":"agent-disabled"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid_request, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_request" {
		t.Errorf("expected error=invalid_request, got %v", resp["error"])
	}
}

// 6. Approve with agent_id pointing at a HUMAN user. Plan §4.1.1
// wants 400 invalid_request; LookupAgent rejects rows whose type is
// not AGENT. (plan §4.1.6 #6)
func TestApproveAgentScenario6_NonAgentIDReturns400(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0006", "kanban:read", time.Hour)
	seedHumanWithRole(t, db, "user-other", "Other Admin", "ADMIN")
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0006","decision":"approve","agentId":"user-other"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid_request, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_request" {
		t.Errorf("expected error=invalid_request, got %v", resp["error"])
	}
}

// 7. Approve as MEMBER with agent_id of an ADMIN-role Agent. Plan
// §4.1.1 wants 403 forbidden; LookupAgent gates ADMIN-role Agents to
// ADMIN approvers in Phase 1. (plan §4.1.6 #7)
func TestApproveAgentScenario7_MemberBindingToAdminAgentReturns403(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0007", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin", "Admin Agent", "ADMIN", true)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve",
		strings.NewReader(`{"user_code":"SCEN-0007","decision":"approve","agentId":"agent-admin"}`))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(req, db, "member-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 forbidden, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error"] != "forbidden" {
		t.Errorf("expected error=forbidden, got %v", resp["error"])
	}
	var status string
	_ = db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'SCEN-0007'`,
	).Scan(&status)
	if status != "pending" {
		t.Errorf("expected device code still pending, got %q", status)
	}
}

// 8. Approve as ADMIN with any enabled agent_id — bound to that
// Agent. (plan §4.1.6 #8)
func TestApproveAgentScenario8_AdminBindsToAnyEnabledAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0008", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-a", "A", "ADMIN", true)
	seedAgentWithRole(t, db, "agent-m", "M", "MEMBER", true)
	r := newApproveServer(t, db)

	cases := []struct {
		uc, agentID string
	}{
		{"SCEN-08-A", "agent-a"},
		{"SCEN-08-M", "agent-m"},
	}
	for _, tc := range cases {
		insertPendingDevice(t, db, "kanban-cli", tc.uc, "kanban:read", time.Hour)
		w := postApproveAs(t, r, db, "user-1",
			`{"user_code":"`+tc.uc+`","decision":"approve","agentId":"`+tc.agentID+`"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("agent=%s expected 200, got %d: %s", tc.agentID, w.Code, w.Body.String())
		}
		var bound string
		_ = db.QueryRow(
			`SELECT user_id FROM oauth_device_codes WHERE user_code_display = ?`, tc.uc,
		).Scan(&bound)
		if bound != tc.agentID {
			t.Errorf("agent=%s expected bound %s, got %q", tc.agentID, tc.agentID, bound)
		}
	}
}

// 9. Approve with oauth_device_require_agent_selection=1, no
// agent_id, no global. The plan §4.1.4 + s-1112.5 wiring make the
// handler reject the request with 400 invalid_request; the device
// code row stays untouched so the approver can resubmit with an
// explicit agent_id (or after clearing the flag). (plan §4.1.6 #9)
func TestApproveAgentScenario9_RequireAgentNoBindingFallsBack(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0009", "kanban:read", time.Hour)
	// s-1112.5 wired the require_agent_selection key into
	// DefaultConfig() so SetConfig accepts it; use the helper to stay
	// in sync with the production schema.
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("seed require_agent_selection: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0009","decision":"approve"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid_request, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error"] != "invalid_request" {
		t.Errorf("expected error=invalid_request, got %v", resp["error"])
	}
	var status string
	if err := db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'SCEN-0009'`,
	).Scan(&status); err != nil {
		t.Fatalf("query: %v", err)
	}
	if status != "pending" {
		t.Errorf("expected device code still pending, got %q", status)
	}
}

// 10. Approve with oauth_device_require_agent_selection=1, approver
// is themselves type='AGENT' — the strict-mode gate (s-1112.5)
// bypasses because binding to the approver's own Agent row is the
// desired outcome, so the device code is bound to the approver (the
// agent). (plan §4.1.6 #10)
func TestApproveAgentScenario10_RequireAgentApproverIsAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0010", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-self", "Self", "ADMIN", true)
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("seed require_agent_selection: %v", err)
	}
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve",
		strings.NewReader(`{"user_code":"SCEN-0010","decision":"approve"}`))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserAsAgent(req, db, "agent-self", "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'SCEN-0010'`,
	).Scan(&bound)
	if bound != "agent-self" {
		t.Errorf("expected bound agent-self, got %q", bound)
	}
}

// 11. Lookup returns agent_selection_required=true for CLI clients.
// The plan §4.1.2 adds the field with a heuristic based on the client
// name; today the lookup payload doesn't include the field at all, so
// the test asserts the current absent semantics. (plan §4.1.6 #11)
func TestApproveAgentScenario11_LookupAgentSelectionRequiredForCLI(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0011", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-a", "A", "ADMIN", true)
	r := newApproveServer(t, db)

	resp := lookupDevice(t, r, "scen-0011")
	if v, ok := resp["agent_selection_required"]; ok {
		// Once s-1112.3 ships the field, the CLI client must be flagged
		// so the page renders the identity picker.
		if got, _ := v.(bool); !got {
			t.Errorf("expected agent_selection_required=true for CLI client, got %v", v)
		}
	}
}

// 12. Lookup returns agent_selection_required=false for the web SPA
// client. (plan §4.1.6 #12)
func TestApproveAgentScenario12_LookupAgentSelectionRequiredFalseForSPA(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-spa", "", "open-kanban",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(
		`UPDATE oauth_clients SET is_first_party = 1 WHERE client_id = 'kanban-spa'`,
	); err != nil {
		t.Fatalf("seed first-party: %v", err)
	}
	insertPendingDevice(t, db, "kanban-spa", "SCEN-0012", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-a", "A", "ADMIN", true)
	r := newApproveServer(t, db)

	resp := lookupDevice(t, r, "scen-0012")
	if v, ok := resp["agent_selection_required"]; ok {
		if got, _ := v.(bool); got {
			t.Errorf("expected agent_selection_required=false for SPA client, got %v", v)
		}
	}
}

// 13. Lookup returns the correct filtered agent list per role. The
// plan §4.1.2 splits visibility: ADMIN sees all enabled Agents,
// MEMBER/VIEWER see only non-ADMIN-role Agents. Today's lookup hides
// the list from non-admin sessions entirely and shows all enabled
// Agents to admins. This test pins both branches so the s-1112.3
// refinement doesn't regress the happy path. (plan §4.1.6 #13)
func TestApproveAgentScenario13_LookupAgentListFilteredByRole(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0013", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true)
	seedAgentWithRole(t, db, "agent-member-role", "Member Agent", "MEMBER", true)
	seedAgentWithRole(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true)
	r := newApproveServer(t, db)

	t.Run("admin sees all enabled agents", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?code=scen-0013", nil)
		setApproveUserRole(req, db, "admin-x", "ADMIN")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var resp map[string]interface{}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		agents, ok := resp["agents"].([]interface{})
		if !ok || len(agents) != 3 {
			t.Errorf("expected admin to see 3 agents, got %v", resp["agents"])
		}
	})

	t.Run("member sees no agents today", func(t *testing.T) {
		// The legacy admin-only gate means non-admin sessions get an
		// empty payload. s-1112.3 will replace this with the per-role
		// filter; once it ships, this assertion will need to flip to
		// expect exactly the non-ADMIN agents (member + viewer).
		req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?code=scen-0013", nil)
		setApproveUserRole(req, db, "member-x", "MEMBER")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var resp map[string]interface{}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if _, hasAgents := resp["agents"]; hasAgents {
			t.Errorf("expected no agents key for MEMBER, got %v", resp["agents"])
		}
	})
}

// 14. Consent row records the bound Agent id, not the approver.
// The plan §4.1.1 wants the consent key on the bound identity. The
// handler (post s-1118) keys consent on the BOUND identity, so a
// device flow that delegates to an Agent creates / updates the
// Agent's oauth_consents row rather than the human approver's.
// (plan §4.1.6 #14)
func TestApproveAgentScenario14_ConsentBoundToAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0014", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-consent", "Consent", "ADMIN", true)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0014","decision":"approve","agentId":"agent-consent"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	// After s-1118, consent keys on the bound Agent (plan §4.1.1,
	// §4.4): the row lives under agent-consent, not user-1.
	var consentUser string
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_consents WHERE client_id = 'kanban-cli'`,
	).Scan(&consentUser); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if consentUser != "agent-consent" {
		t.Errorf("expected consent on bound Agent agent-consent, got %q", consentUser)
	}
}

// 15. Activity log records actor=human, target=agent. The plan
// §4.1.1 + §4.4 want an audit row every time a human approver
// delegates a device code to an Agent. The handler (post s-1118)
// inserts a DEVICE_APPROVE row with user_id=approver,
// target_id=bound Agent, target_type=DEVICE. (plan §4.1.6 #15)
func TestApproveAgentScenario15_ActivityLogActorAndTarget(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	// Activities is part of the production schema but is not seeded
	// by setupAgentApprovalDB (which only adds the legacy
	// activity_log table); create the canonical activities table here
	// so the device approval handler can write the audit row.
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS activities (
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
	)`); err != nil {
		t.Fatalf("activities schema: %v", err)
	}
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-0015", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-log", "Log", "ADMIN", true)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"SCEN-0015","decision":"approve","agentId":"agent-log"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	// The handler should write a DEVICE_APPROVE row pointing at the
	// bound Agent (plan §4.1.1 + §4.4).
	var (
		actor, action, targetType, targetID string
	)
	if err := db.QueryRow(
		`SELECT user_id, action, target_type, target_id FROM activities ORDER BY created_at DESC LIMIT 1`,
	).Scan(&actor, &action, &targetType, &targetID); err != nil {
		t.Fatalf("query activities: %v", err)
	}
	if action != "DEVICE_APPROVE" {
		t.Errorf("expected DEVICE_APPROVE activity, got %q", action)
	}
	if actor != "user-1" {
		t.Errorf("expected actor=user-1, got %q", actor)
	}
	if targetType != "DEVICE" {
		t.Errorf("expected target_type=DEVICE, got %q", targetType)
	}
	if targetID != "agent-log" {
		t.Errorf("expected target_id=agent-log, got %q", targetID)
	}
}

// setApproveUserAsAgent is the AGENT counterpart of setApproveUserRole:
// it seeds a user of type='AGENT' with a fresh token so the
// "approver is themselves an Agent" branch is exercised.
func setApproveUserAsAgent(req *http.Request, db *sql.DB, userID, role string) {
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled)
		 VALUES (?, ?, ?, '', 'AGENT', ?, 1)`,
		userID, userID, userID, role,
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

// Sanity check that all the scenarios share the same gin wiring as the
// existing approve tests — guards against the route group ever
// drifting to a private middleware that would silently change auth
// semantics for s-1112.7 tests.
func TestApproveAgentScenarioWiring(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	r := newApproveServer(t, db)
	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 on empty lookup, got %d", w.Code)
	}
}

// The tests below exercise the strict-mode behaviour that s-1112.5
// wired in: when oauth_device_require_agent_selection=1, the
// /oauth/device/approve endpoint must refuse to bind a device code
// to a HUMAN row unless the approver is themselves type='AGENT'.
// They live alongside the §4.1.6 scenarios so the s-1112.5 contract
// stays co-located with the related agent-binding plumbing.

// TestRequireAgentSelection_DefaultOff_LegacyBinding verifies that
// when the strict-mode flag is left at its default ("0"), the
// legacy "approve as the logged-in user" path keeps working for
// HUMAN approvers. s-1112.5 must be opt-in so existing deployments
// don't get locked out on rollout.
func TestRequireAgentSelection_DefaultOff_LegacyBinding(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "REQ-DEFAULT", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"REQ-DEFAULT","decision":"approve"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (default off), got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'REQ-DEFAULT'`,
	).Scan(&bound)
	if bound != "user-1" {
		t.Errorf("expected legacy bind to user-1, got %q", bound)
	}
}

// TestRequireAgentSelection_HumanApproverNoBindingReturns400 is the
// canonical s-1112.5 happy path: a HUMAN approver submits an
// approval with neither agent_id nor the global override while the
// strict-mode flag is on. The handler must reject with 400
// invalid_request so `kanban run` / CLI consumers cannot ride on a
// human approver's identity. The device code row stays pending so
// the approver can retry with an explicit agent_id.
func TestRequireAgentSelection_HumanApproverNoBindingReturns400(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "REQ-HUMAN1", "kanban:read", time.Hour)
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"REQ-HUMAN1","decision":"approve"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "invalid_request" {
		t.Errorf("expected error=invalid_request, got %v", resp["error"])
	}
	if desc, _ := resp["error_description"].(string); desc == "" {
		t.Error("expected non-empty error_description")
	}
	var status string
	_ = db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'REQ-HUMAN1'`,
	).Scan(&status)
	if status != "pending" {
		t.Errorf("expected device code still pending, got %q", status)
	}
}

// TestRequireAgentSelection_ExplicitAgentIDAllowed confirms that
// even with the strict-mode flag on, supplying an explicit agent_id
// keeps the existing §4.1.1 behaviour: the handler validates the id
// via LookupAgent and binds to the resolved Agent.
func TestRequireAgentSelection_ExplicitAgentIDAllowed(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "REQ-AGID1", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-strict", "Strict", "ADMIN", true)
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"REQ-AGID1","decision":"approve","agentId":"agent-strict"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'REQ-AGID1'`,
	).Scan(&bound)
	if bound != "agent-strict" {
		t.Errorf("expected bound agent-strict, got %q", bound)
	}
}

// TestRequireAgentSelection_GlobalBindingAllowed covers the
// admin-pinned fallback: when oauth_device_agent_id is set
// globally, the device code binds to that Agent even in strict
// mode, so kiosk-style deployments don't have to push the per-call
// agent_id through the device authorization page.
func TestRequireAgentSelection_GlobalBindingAllowed(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "REQ-GLOB1", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-kiosk", "Kiosk", "ADMIN", true)
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if err := oauth.SetConfig(db, "oauth_device_agent_id", "agent-kiosk"); err != nil {
		t.Fatalf("SetConfig global: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"REQ-GLOB1","decision":"approve"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'REQ-GLOB1'`,
	).Scan(&bound)
	if bound != "agent-kiosk" {
		t.Errorf("expected bound agent-kiosk via global override, got %q", bound)
	}
}

// TestRequireAgentSelection_DenyAlwaysAllowed pins the contract that
// the strict-mode gate is bound to the approve branch only — the
// deny path is a refusal and must not be subject to the agent_id
// requirement (it carries no binding semantics).
func TestRequireAgentSelection_DenyAlwaysAllowed(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "REQ-DENY1", "kanban:read", time.Hour)
	if err := oauth.SetConfig(db, "oauth_device_require_agent_selection", "1"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	r := newApproveServer(t, db)

	w := postApproveAs(t, r, db, "user-1",
		`{"user_code":"REQ-DENY1","decision":"deny"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on deny, got %d: %s", w.Code, w.Body.String())
	}
	var status string
	_ = db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'REQ-DENY1'`,
	).Scan(&status)
	if status != "denied" {
		t.Errorf("expected status denied, got %q", status)
	}
}
