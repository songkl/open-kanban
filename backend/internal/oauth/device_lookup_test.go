package oauth_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/models"
	"open-kanban/internal/oauth"
)

// The tests in this file cover s-1112.3 (plan §4.1.2) — the lookup
// affordances that let the device-flow authorization page decide
// whether to render the Agent-identity picker and which Agents the
// caller can actually delegate to. Two pieces of contract:
//
//   1. `agent_selection_required` is a bool that flips on for
//      CLI / MCP consumers (heuristic: client.name matches the
//      `-cli` family, OR grant_types contains device_code AND the
//      client is NOT flagged first-party-human).
//   2. `available_agents[]` is the role-filtered list of Agents the
//      caller may delegate to: ADMIN sees everyone enabled, MEMBER /
//      VIEWER see only non-ADMIN Agents, anonymous sees nothing.

// --- pure-helper coverage ------------------------------------------------

// TestIsAgentSelectionRequiredMatrix walks every branch of the heuristic
// in plan §4.1.2 — nil client, name match (with case-folding and the
// explicit kanban-cli / open-kanban-cli literals), device_code grant with
// and without is_first_party, and the default false branch. The function
// is pure (no DB) so we drive it with synthesised OAuthClient values
// rather than going through insertClient().
func TestIsAgentSelectionRequiredMatrix(t *testing.T) {
	cases := []struct {
		name string
		in   *models.OAuthClient
		want bool
	}{
		{
			name: "nil client is not a CLI",
			in:   nil,
			want: false,
		},
		{
			name: "kanban-cli literal triggers",
			in:   &models.OAuthClient{Name: "kanban-cli"},
			want: true,
		},
		{
			name: "open-kanban-cli literal triggers",
			in:   &models.OAuthClient{Name: "open-kanban-cli"},
			want: true,
		},
		{
			name: "uppercase kanban-cli still triggers (case-insensitive)",
			in:   &models.OAuthClient{Name: "Kanban-CLI"},
			want: true,
		},
		{
			name: "generic -cli suffix triggers",
			in:   &models.OAuthClient{Name: "my-custom-cli"},
			want: true,
		},
		{
			name: "non-cli name with device_code and not first-party triggers",
			in: &models.OAuthClient{
				Name:         "open-kanban-mcp",
				GrantTypes:   []string{"urn:ietf:params:oauth:grant-type:device_code"},
				IsFirstParty: false,
			},
			want: true,
		},
		{
			name: "non-cli name without device_code is not a CLI",
			in: &models.OAuthClient{
				Name:       "open-kanban-mcp",
				GrantTypes: []string{"authorization_code"},
			},
			want: false,
		},
		{
			name: "first-party human client with device_code does not trigger",
			in: &models.OAuthClient{
				Name:         "open-kanban",
				GrantTypes:   []string{"urn:ietf:params:oauth:grant-type:device_code"},
				IsFirstParty: true,
			},
			want: false,
		},
		{
			name: "non-cli name with device_code and missing is_first_party still triggers",
			// IsFirstParty defaults to false so the heuristic
			// activates; this mirrors a freshly-registered
			// open-kanban-mcp row.
			in: &models.OAuthClient{
				Name:       "open-kanban-mcp",
				GrantTypes: []string{"urn:ietf:params:oauth:grant-type:device_code"},
			},
			want: true,
		},
		{
			name: "non-cli name with whitespace around cli suffix still triggers",
			in:   &models.OAuthClient{Name: "  kanban-cli  "},
			want: true,
		},
		{
			name: "non-cli name without dash-cli suffix is not a CLI",
			in:   &models.OAuthClient{Name: "mycli"},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := oauth.IsAgentSelectionRequired(tc.in)
			if got != tc.want {
				t.Errorf("IsAgentSelectionRequired(%+v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// --- integration coverage against DeviceLookupHandler --------------------

// deviceLookupRequest issues a GET /oauth/device/lookup as the supplied
// caller (or anonymously when callerID is empty). Returns the decoded
// JSON body so each subtest can assert on the new fields without
// repeating the boilerplate.
func deviceLookupRequest(t *testing.T, r *gin.Engine, db *sql.DB, callerID, callerRole, code string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?code="+code, nil)
	if callerID != "" {
		setApproveUserRole(req, db, callerID, callerRole)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var body map[string]interface{}
	if w.Body.Len() > 0 {
		_ = json.Unmarshal(w.Body.Bytes(), &body)
	}
	return w.Code, body
}

// agentIDsFromLookup extracts the `id` field from each entry of the
// `available_agents` array. Returns nil when the key is missing or the
// value isn't a JSON array so callers can assert "MEMBER sees no Agents
// (post-filter empty list)" without nil-checking themselves.
func agentIDsFromLookup(body map[string]interface{}) []string {
	raw, ok := body["available_agents"].([]interface{})
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

// 1. Lookup includes `agent_selection_required=true` for a CLI client
// whose name matches the `kanban-cli` family, even when no session is
// attached — the field is client-derived, not caller-derived. (plan
// §4.1.2)
func TestDeviceLookup_AgentSelectionRequiredTrueForKanbanCLI(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-KCLI", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-kcli")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, ok := body["agent_selection_required"].(bool)
	if !ok {
		t.Fatalf("expected agent_selection_required bool, got %v", body["agent_selection_required"])
	}
	if !got {
		t.Errorf("expected agent_selection_required=true for kanban-cli, got false")
	}
}

// 2. Lookup includes `agent_selection_required=true` for the
// `open-kanban-cli` literal and other `-cli` suffixes (case-insensitive).
func TestDeviceLookup_AgentSelectionRequiredTrueForOpenKanbanCLI(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "open-kanban-cli", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "open-kanban-cli", "ASR-OKCL", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-okcl")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, _ := body["agent_selection_required"].(bool)
	if !got {
		t.Errorf("expected agent_selection_required=true for open-kanban-cli, got false")
	}
}

// 3. Lookup includes `agent_selection_required=true` for a non-CLI-named
// client whose grant_types contain device_code AND that is NOT flagged
// first-party-human — this is the implicit-CLI branch of the heuristic.
func TestDeviceLookup_AgentSelectionRequiredTrueForDeviceCodeClient(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "open-kanban-mcp", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "open-kanban-mcp", "ASR-DCCP", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-dccp")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, _ := body["agent_selection_required"].(bool)
	if !got {
		t.Errorf("expected agent_selection_required=true for device_code-only MCP client, got false")
	}
}

// 4. Lookup includes `agent_selection_required=false` for a client
// whose grant_types don't include device_code — the implicit-CLI branch
// is gated on that grant type.
func TestDeviceLookup_AgentSelectionRequiredFalseWithoutDeviceCode(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-web", "", "kanban-web",
		[]string{"authorization_code", "refresh_token"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-web", "ASR-NODC", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-nodc")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, _ := body["agent_selection_required"].(bool)
	if got {
		t.Errorf("expected agent_selection_required=false for kanban-web (no device_code), got true")
	}
}

// 5. Lookup includes `agent_selection_required=false` for the first-party
// human web SPA — the page must not flip on the picker for our own
// in-house web client even when it requests device_code grants. This is
// the `is_first_party=1` exception referenced by plan §4.1.2. (plan
// §4.1.6 #12 — pinned here as well so the field surface doesn't drift.)
func TestDeviceLookup_AgentSelectionRequiredFalseForFirstPartySPA(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-spa", "", "open-kanban",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	if _, err := db.Exec(
		`UPDATE oauth_clients SET is_first_party = 1 WHERE client_id = 'kanban-spa'`,
	); err != nil {
		t.Fatalf("seed first-party: %v", err)
	}
	insertPendingDevice(t, db, "kanban-spa", "ASR-FPSP", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-fpsp")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, _ := body["agent_selection_required"].(bool)
	if got {
		t.Errorf("expected agent_selection_required=false for first-party SPA, got true")
	}
}

// 6. Anonymous lookup still includes `agent_selection_required` (the
// field is client-derived, not caller-derived) and returns an empty
// `available_agents` array — the picker must hide itself when no user
// is attached.
func TestDeviceLookup_AnonymousEmptyAvailableAgents(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-ANON", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "", "", "asr-anon")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	got, _ := body["agent_selection_required"].(bool)
	if !got {
		t.Errorf("expected agent_selection_required=true (CLI client), got false")
	}
	agents := agentIDsFromLookup(body)
	if len(agents) != 0 {
		t.Errorf("expected empty available_agents for anonymous lookup, got %v", agents)
	}
	// Re-marshal so the empty-array literal (`[]`) is asserted
	// against the wire format, not the json.Unmarshal-folds-into-nil
	// behaviour. Mirrors the DeviceAgents test (plan §4.1.3).
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"available_agents":[]`) {
		t.Errorf("expected empty array literal in JSON, got %s", raw)
	}
}

// 7. ADMIN caller sees every enabled Agent. Reuses the per-role filter
// that backs GET /oauth/device/agents (plan §4.1.3) so the two
// endpoints stay in lockstep. (plan §4.1.6 #13 admin branch.)
func TestDeviceLookup_AdminSeesAllEnabledAgents(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-ADMN", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true)
	seedAgentWithRole(t, db, "agent-member-role", "Member Agent", "MEMBER", true)
	seedAgentWithRole(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "admin-x", "ADMIN", "asr-admn")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromLookup(body)
	want := []string{"agent-admin-role", "agent-member-role", "agent-viewer-role"}
	if len(ids) != len(want) {
		t.Fatalf("expected admin to see %d agents, got %d (%v)", len(want), len(ids), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("expected sorted id %q at index %d, got %q", want[i], i, ids[i])
		}
	}
}

// 8. MEMBER caller must not see ADMIN-role Agents — they only get the
// non-ADMIN Agents that match their own authority tier. (plan §4.1.6
// #13 member branch.)
func TestDeviceLookup_MemberHidesAdminRoleAgents(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-MEMB", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true)
	seedAgentWithRole(t, db, "agent-member-role", "Member Agent", "MEMBER", true)
	seedAgentWithRole(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "member-x", "MEMBER", "asr-memb")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromLookup(body)
	want := []string{"agent-member-role", "agent-viewer-role"}
	if len(ids) != len(want) {
		t.Fatalf("expected MEMBER to see %d agents, got %d (%v)", len(want), len(ids), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("expected sorted id %q at index %d, got %q", want[i], i, ids[i])
		}
	}
	// Roles in the payload must never include ADMIN for a MEMBER caller.
	for _, entry := range body["available_agents"].([]interface{}) {
		m := entry.(map[string]interface{})
		if role, _ := m["role"].(string); role == "ADMIN" {
			t.Errorf("MEMBER must not see ADMIN-role Agent, got %v", m)
		}
	}
}

// 9. VIEWER caller gets the same MEMBER-tier filter — non-ADMIN Agents
// only.
func TestDeviceLookup_ViewerHidesAdminRoleAgents(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-VIEW", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true)
	seedAgentWithRole(t, db, "agent-viewer-role", "Viewer Agent", "VIEWER", true)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "viewer-x", "VIEWER", "asr-view")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	ids := agentIDsFromLookup(body)
	if len(ids) != 1 || ids[0] != "agent-viewer-role" {
		t.Errorf("expected VIEWER to see only viewer-role agent, got %v", ids)
	}
}

// 10. Empty list serialises as `"available_agents":[]` so the frontend
// can iterate the field unconditionally. Pins the CLAUDE.md guidance
// "Prefer returning empty arrays `[]` over `null` for list responses"
// against this new field.
func TestDeviceLookup_EmptyListSerialisesAsArrayNotNull(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-EMPT", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-admin-role", "Admin Agent", "ADMIN", true)
	r := newApproveServer(t, db)

	// MEMBER caller against a setup with only an ADMIN-role Agent
	// gets an empty visible list (post-filter).
	code, body := deviceLookupRequest(t, r, db, "member-x", "MEMBER", "asr-empt")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"available_agents":[]`) {
		t.Errorf("expected empty array literal in JSON, got %s", raw)
	}
}

// 11. Payload shape: each `available_agents` entry exposes id,
// nickname, username, role — no extra fields leak through so the
// frontend can reuse the rendering path shared with the dedicated
// /oauth/device/agents endpoint (plan §4.1.3).
func TestDeviceLookup_AvailableAgentsPayloadShape(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-SHAP", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-alpha", "Alpha", "ADMIN", true)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "admin-x", "ADMIN", "asr-shap")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	raw, ok := body["available_agents"].([]interface{})
	if !ok || len(raw) != 1 {
		t.Fatalf("expected exactly one agent, got %v", body["available_agents"])
	}
	entry := raw[0].(map[string]interface{})
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
	for _, forbidden := range []string{"enabled", "type", "avatar", "createdAt"} {
		if _, present := entry[forbidden]; present {
			t.Errorf("entry unexpectedly contains %q", forbidden)
		}
	}
}

// 12. The legacy `agents` field is gone — s-1112.3 replaces it with
// `available_agents` to align with the dedicated endpoint's payload
// naming and to avoid the false impression that this list is
// admin-only.
func TestDeviceLookup_LegacyAgentsFieldRemoved(t *testing.T) {
	db := setupApproveDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "ASR-LEGC", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-alpha", "Alpha", "ADMIN", true)
	r := newApproveServer(t, db)

	code, body := deviceLookupRequest(t, r, db, "admin-x", "ADMIN", "asr-legc")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %v", code, body)
	}
	if _, present := body["agents"]; present {
		t.Errorf("legacy `agents` field should be replaced by `available_agents`, got %v", body["agents"])
	}
}
