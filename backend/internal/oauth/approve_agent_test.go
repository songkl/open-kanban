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

	"open-kanban/internal/handlers"
	"open-kanban/internal/models"
	"open-kanban/internal/oauth"
)

// setupApproveAgentDB seeds the same schema as setupApproveDB but extends
// the users table to support the AGENT / disabled / role columns the
// approve-as-agent code paths exercise. It also writes an empty
// oauth_consents table so the consent assertions have a place to land.
func setupApproveAgentDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupTokenDB(t)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS oauth_consents (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(user_id, client_id)
	)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

// insertUser seeds a row in users with the supplied attributes. The id is
// the primary key; callers should pick a stable id like "agent-bot-1".
func insertUser(t *testing.T, db *sql.DB, id, username, nickname, userType, role string, enabled bool) {
	t.Helper()
	enabledInt := 0
	if enabled {
		enabledInt = 1
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
		id, username, nickname, userType, role, enabledInt, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("insert user %s: %v", id, err)
	}
}

// setApproveUserRole seeds a HUMAN user with the supplied role and
// attaches a bearer cookie so the embedded auth middleware can pick it
// up. Tests pass userRole = "ADMIN" or "MEMBER" / "VIEWER" depending on
// the permission gate they want to exercise.
func setApproveUserRole(t *testing.T, req *http.Request, db *sql.DB, userID, role string) {
	t.Helper()
	enabledInt := 1
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, '', 'HUMAN', ?, ?, ?, ?)`,
		userID, userID, userID, role, enabledInt, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed approver: %v", err)
	}
	key := "test-token-" + userID
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO tokens (id, name, key, user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"tok-"+userID, "test", key, userID, time.Now(), time.Now(),
	); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: key})
}

// TestApproveWithAgentIDBindsDeviceCodeToAgent confirms the happy path:
// when the approver picks an enabled Agent in the picker, the device
// code is bound to that Agent (not the human approver) and the consent
// row records the Agent id.
func TestApproveWithAgentIDBindsDeviceCodeToAgent(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "agent-bot-1", "agent-bot-1", "Bot", "AGENT", "MEMBER", true)
	insertPendingDevice(t, db, "kanban-cli-1", "AGNT-AGNT", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"AGNT-AGNT","decision":"approve","agent_id":"agent-bot-1"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var boundUser sql.NullString
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'AGNT-AGNT'`,
	).Scan(&boundUser); err != nil {
		t.Fatalf("query: %v", err)
	}
	if !boundUser.Valid || boundUser.String != "agent-bot-1" {
		t.Errorf("expected device code bound to agent-bot-1, got %v", boundUser)
	}

	var consentUser sql.NullString
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_consents WHERE client_id = 'kanban-cli-1'`,
	).Scan(&consentUser); err != nil {
		t.Fatalf("consent: %v", err)
	}
	if consentUser.String != "agent-bot-1" {
		t.Errorf("expected consent bound to agent-bot-1, got %q", consentUser.String)
	}
}

// TestApproveWithEmptyAgentIDFallsBackToHuman covers the no-op path: the
// approver picks "Myself" so the field is omitted (or empty) and the
// device code binds to the human approver exactly as before s-1233.
func TestApproveWithEmptyAgentIDFallsBackToHuman(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli-1", "HUMN-HUMN", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"HUMN-HUMN","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'HUMN-HUMN'`,
	).Scan(&bound); err != nil {
		t.Fatalf("query: %v", err)
	}
	if bound != "human-1" {
		t.Errorf("expected device code bound to human-1, got %q", bound)
	}
}

// TestApproveWithUnknownAgentIDReturns400 covers the validation failure:
// the picker submits a stale id and the server rejects with
// invalid_request before touching the device code row.
func TestApproveWithUnknownAgentIDReturns400(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli-1", "UNKN-UNKN", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"UNKN-UNKN","decision":"approve","agent_id":"does-not-exist"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	var status string
	if err := db.QueryRow(
		`SELECT status FROM oauth_device_codes WHERE user_code_display = 'UNKN-UNKN'`,
	).Scan(&status); err != nil {
		t.Fatalf("query: %v", err)
	}
	if status != "pending" {
		t.Errorf("device code must remain pending, got %s", status)
	}
}

// TestApproveWithDisabledAgentIDReturns400 confirms the picker can not
// silently bind a token to a disabled Agent.
func TestApproveWithDisabledAgentIDReturns400(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "agent-bot-1", "agent-bot-1", "Bot", "AGENT", "MEMBER", false)
	insertPendingDevice(t, db, "kanban-cli-1", "DSBL-124", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"DSBL-124","decision":"approve","agent_id":"agent-bot-1"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestApproveWithHumanAgentIDReturns400 ensures the picker cannot bind a
// device flow to another human's account.
func TestApproveWithHumanAgentIDReturns400(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "another-human", "another-human", "Other", "HUMAN", "ADMIN", true)
	insertPendingDevice(t, db, "kanban-cli-1", "HUAG-1234", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"HUAG-1234","decision":"approve","agent_id":"another-human"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestApproveAsMemberWithAdminAgentIDReturns403 covers the visibility
// gate: a MEMBER human must not be able to bind to an ADMIN-role Agent.
func TestApproveAsMemberWithAdminAgentIDReturns403(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "admin-agent", "admin-agent", "AdminBot", "AGENT", "ADMIN", true)
	insertPendingDevice(t, db, "kanban-cli-1", "ADMN-ADMN", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"ADMN-ADMN","decision":"approve","agent_id":"admin-agent"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "member-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	var status string
	_ = db.QueryRow(`SELECT status FROM oauth_device_codes WHERE user_code_display = 'ADMN-ADMN'`).Scan(&status)
	if status != "pending" {
		t.Errorf("device code must remain pending, got %s", status)
	}
}

// TestApproveAsAdminWithAnyAgentIDReturns200 confirms the ADMIN-only
// path: any enabled AGENT user can be the binding target.
func TestApproveAsAdminWithAnyAgentIDReturns200(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "admin-agent", "admin-agent", "AdminBot", "AGENT", "ADMIN", true)
	insertPendingDevice(t, db, "kanban-cli-1", "ADOK-1234", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"ADOK-1234","decision":"approve","agent_id":"admin-agent"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "admin-1", "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'ADOK-1234'`).Scan(&bound)
	if bound != "admin-agent" {
		t.Errorf("expected admin-agent, got %q", bound)
	}
}

// TestApproveWithGlobalAgentIDFallbackBindsToAgent covers the legacy
// global config: a human approver who does NOT pass an explicit
// agent_id still gets the configured Agent pinned when oauth_device_agent_id
// is set in app_config.
func TestApproveWithGlobalAgentIDFallbackBindsToAgent(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "default-bot", "default-bot", "DefaultBot", "AGENT", "MEMBER", true)
	if _, err := db.Exec(
		`INSERT INTO app_config (key, value) VALUES ('oauth_device_agent_id', 'default-bot')`,
	); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	insertPendingDevice(t, db, "kanban-cli-1", "GLBL-GLBL", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"GLBL-GLBL","decision":"approve"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "admin-1", "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'GLBL-GLBL'`).Scan(&bound)
	if bound != "default-bot" {
		t.Errorf("expected default-bot, got %q", bound)
	}
}

// TestDeviceLookupReturnsAgentSelectionMetadata confirms the
// authenticated lookup surfaces agentSelectionRequired + the visible
// agent list so the picker can render.
func TestDeviceLookupReturnsAgentSelectionMetadata(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "agent-bot-1", "agent-bot-1", "Bot1", "AGENT", "MEMBER", true)
	insertUser(t, db, "agent-bot-2", "agent-bot-2", "Bot2", "AGENT", "ADMIN", true)
	insertUser(t, db, "agent-disabled", "agent-disabled", "Off", "AGENT", "MEMBER", false)
	insertPendingDevice(t, db, "kanban-cli-1", "META-META", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=meta-meta", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token-member-1"})
	setApproveUserRole(t, req, db, "member-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if v, _ := resp["agentSelectionRequired"].(bool); !v {
		t.Errorf("expected agentSelectionRequired=true for CLI client, got %v", resp["agentSelectionRequired"])
	}
	agents, _ := resp["availableAgents"].([]interface{})
	if len(agents) != 1 {
		// MEMBER must only see non-ADMIN-role Agents; admin-bot-2 and
		// the disabled Agent must both be filtered out.
		t.Fatalf("expected 1 visible agent for MEMBER approver, got %d (%v)", len(agents), resp["availableAgents"])
	}
	first := agents[0].(map[string]interface{})
	if first["id"] != "agent-bot-1" {
		t.Errorf("expected agent-bot-1, got %v", first["id"])
	}
	if _, ok := resp["defaultAgentId"]; ok {
		t.Errorf("defaultAgentId should be omitted when oauth_device_agent_id is unset, got %v", resp["defaultAgentId"])
	}
}

// TestDeviceLookupReturnsDefaultAgentIDForAdmin surfaces the global
// oauth_device_agent_id fallback as defaultAgentId when the approver
// is allowed to act on it.
func TestDeviceLookupReturnsDefaultAgentIDForAdmin(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "admin-agent", "admin-agent", "AdminBot", "AGENT", "ADMIN", true)
	if _, err := db.Exec(
		`INSERT INTO app_config (key, value) VALUES ('oauth_device_agent_id', 'admin-agent')`,
	); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	insertPendingDevice(t, db, "kanban-cli-1", "DFLT-DFLT", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=dflt-dflt", nil)
	setApproveUserRole(t, req, db, "admin-1", "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["defaultAgentId"] != "admin-agent" {
		t.Errorf("expected defaultAgentId=admin-agent, got %v", resp["defaultAgentId"])
	}
}

// TestDeviceLookupHidesAgentMetadataWhenAnonymous covers the unauth'd
// path: when the visitor hasn't logged in yet the lookup must keep the
// minimal shape (no picker metadata) so the page can decide whether to
// redirect to /login first.
func TestDeviceLookupHidesAgentMetadataWhenAnonymous(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli-1", "ANON-ANON", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=anon-anon", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if _, ok := resp["agentSelectionRequired"]; ok {
		t.Errorf("expected no agentSelectionRequired for anonymous lookup, got %v", resp)
	}
	if _, ok := resp["availableAgents"]; ok {
		t.Errorf("expected no availableAgents for anonymous lookup, got %v", resp)
	}
}

// TestDeviceLookupSkipsPickerForFirstPartyClient confirms the picker is
// NOT rendered for non-CLI clients (kanban-web etc.), even when an
// approver is logged in.
func TestDeviceLookupSkipsPickerForFirstPartyClient(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-web-1", "", "kanban-web",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "agent-bot-1", "agent-bot-1", "Bot", "AGENT", "MEMBER", true)
	insertPendingDevice(t, db, "kanban-web-1", "FRST-FRST", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	req := httptest.NewRequest(http.MethodGet, "/oauth/device/lookup?user_code=frst-frst", nil)
	setApproveUserRole(t, req, db, "admin-1", "ADMIN")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if v, _ := resp["agentSelectionRequired"].(bool); v {
		t.Errorf("expected agentSelectionRequired=false for non-CLI client, got true")
	}
}

// TestRequestDeviceCodeEchoesAudienceType confirms the extension
// parameter is normalised + echoed back so the CLI / MCP server can
// confirm the server understood its hint.
func TestRequestDeviceCodeEchoesAudienceType(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-cli-1&scope=kanban:read&audience_type=agent"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["audience_type"] != "agent" {
		t.Errorf("expected audience_type=agent, got %v", resp["audience_type"])
	}
}

// TestRequestDeviceCodeNormalisesUnknownAudienceType confirms unknown
// values are silently coerced to "" so the server can fall back to the
// client-name heuristic without leaking garbage into the response.
func TestRequestDeviceCodeNormalisesUnknownAudienceType(t *testing.T) {
	db := setupDeviceDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newDeviceServer(t, db)

	body := "client_id=kanban-cli-1&scope=kanban:read&audience_type=garbage"
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = "kanban.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if v, _ := resp["audience_type"].(string); v != "" {
		t.Errorf("expected audience_type='', got %q", v)
	}
}

// TestAgentSelectionRequiredHelper exercises the heuristic directly so
// regressions in the client-name rules are caught immediately.
func TestAgentSelectionRequiredHelper(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"open-kanban-cli", true},
		{"kanban-cli", true},
		{"foo-cli", true},
		{"my-bot-cli", true},
		{"kanban-web", false},
		{"", false},
		{"open-kanban-mcp", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &models.OAuthClient{Name: tc.name}
			if got := oauth.AgentSelectionRequiredForTest(client); got != tc.want {
				t.Errorf("AgentSelectionRequired(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

// TestDenyWithAgentIDMirrorsApprove ensures the deny branch honours the
// same identity resolution so audit / consent records stay consistent.
func TestDenyWithAgentIDMirrorsApprove(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertUser(t, db, "agent-bot-1", "agent-bot-1", "Bot", "AGENT", "MEMBER", true)
	insertPendingDevice(t, db, "kanban-cli-1", "DNYI-DNYI", "kanban:read", time.Hour)
	r := newApproveServer(t, db)

	body := `{"user_code":"DNYI-DNYI","decision":"deny","agent_id":"agent-bot-1"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, req, db, "human-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var bound string
	_ = db.QueryRow(`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'DNYI-DNYI'`).Scan(&bound)
	if bound != "agent-bot-1" {
		t.Errorf("expected device code bound to agent-bot-1, got %q", bound)
	}
	var status string
	_ = db.QueryRow(`SELECT status FROM oauth_device_codes WHERE user_code_display = 'DNYI-DNYI'`).Scan(&status)
	if status != "denied" {
		t.Errorf("expected denied status, got %s", status)
	}
}

// newDeviceCreateAgentServer wires the create-agent endpoint into a fresh
// gin router alongside the existing approve / lookup routes so the table
// tests below can exercise both happy and error paths in isolation.
func newDeviceCreateAgentServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.POST("/oauth/device/create-agent", handlers.RequireAuth(db), oauth.DeviceCreateAgentHandler(db))
	return r
}

// TestDeviceCreateAgentTable drives the POST /oauth/device/create-agent
// endpoint across the documented matrix: ADMIN happy path with default
// role, ADMIN with explicit role, MEMBER refusal, anonymous refusal, and
// missing-nickname validation. Each subtest stands up its own router so a
// panic in one branch can't taint the rest.
func TestDeviceCreateAgentTable(t *testing.T) {
	tests := []struct {
		name       string
		role       string
		nickname   string
		bodyRole   string
		wantStatus int
		wantRole   string
	}{
		{
			name:       "ADMIN defaults role to MEMBER when omitted",
			role:       "ADMIN",
			nickname:   "Admin Bot",
			wantStatus: http.StatusOK,
			wantRole:   "MEMBER",
		},
		{
			name:       "ADMIN can request an explicit VIEWER role",
			role:       "ADMIN",
			nickname:   "Read-Only Bot",
			bodyRole:   "VIEWER",
			wantStatus: http.StatusOK,
			wantRole:   "VIEWER",
		},
		{
			name:       "ADMIN rejects garbage role and falls back to MEMBER",
			role:       "ADMIN",
			nickname:   "Garbage Bot",
			bodyRole:   "owner",
			wantStatus: http.StatusOK,
			wantRole:   "MEMBER",
		},
		{
			name:       "MEMBER approver is forbidden from creating Agents",
			role:       "MEMBER",
			nickname:   "Member Bot",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "VIEWER approver is forbidden from creating Agents",
			role:       "VIEWER",
			nickname:   "Viewer Bot",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "Empty nickname returns 400 even for ADMIN",
			role:       "ADMIN",
			nickname:   "",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "Whitespace-only nickname returns 400",
			role:       "ADMIN",
			nickname:   "   ",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			db := setupApproveAgentDB(t)
			defer db.Close()
			r := newDeviceCreateAgentServer(t, db)
			// Reset the token cache so a previously-cached user from a
			// sibling subtest (e.g. the first ADMIN run) cannot leak into
			// this run via the global tokenCache in handlers/auth.go.
			handlers.ResetTokenCacheForTest()

			// Use a unique approver per subtest so the bearer lookup joins
			// on the right users row and the tokenCache key matches.
			userID := "approver-" + tc.name
			body, _ := json.Marshal(map[string]string{
				"nickname": tc.nickname,
				"role":     tc.bodyRole,
			})
			req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			if tc.wantStatus != http.StatusUnauthorized {
				setApproveUserRole(t, req, db, userID, tc.role)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d: %s", tc.wantStatus, w.Code, w.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}

			var resp struct {
				Agent struct {
					ID       string `json:"id"`
					Nickname string `json:"nickname"`
					Role     string `json:"role"`
					Type     string `json:"type"`
					Enabled  bool   `json:"enabled"`
				} `json:"agent"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.Agent.ID == "" {
				t.Errorf("expected agent.id, got empty")
			}
			if resp.Agent.Type != "AGENT" {
				t.Errorf("expected type=AGENT, got %q", resp.Agent.Type)
			}
			if resp.Agent.Nickname != strings.TrimSpace(tc.nickname) {
				t.Errorf("expected nickname %q, got %q", strings.TrimSpace(tc.nickname), resp.Agent.Nickname)
			}
			if resp.Agent.Role != tc.wantRole {
				t.Errorf("expected role %q, got %q", tc.wantRole, resp.Agent.Role)
			}
			if !resp.Agent.Enabled {
				t.Errorf("expected enabled=true for freshly created Agent")
			}

			// Confirm the row landed in users with the expected columns so
			// future lookups (DeviceLookupHandler → listAvailableAgents) see
			// the new identity without an extra round trip. The
			// users.enabled column is BOOLEAN on SQLite, so scan it as bool.
			var dbType, dbRole string
			var dbEnabled bool
			if err := db.QueryRow(
				`SELECT type, role, enabled FROM users WHERE id = ?`, resp.Agent.ID,
			).Scan(&dbType, &dbRole, &dbEnabled); err != nil {
				t.Fatalf("query user row: %v", err)
			}
			if dbType != "AGENT" || dbRole != tc.wantRole || !dbEnabled {
				t.Errorf("users row mismatch: type=%q role=%q enabled=%v", dbType, dbRole, dbEnabled)
			}
		})
	}
}

// TestDeviceCreateAgentRequiresAuth confirms anonymous visitors (no
// session cookie / bearer) are rejected with 401 before any role check
// runs, mirroring the rest of the /oauth/device/* endpoints.
func TestDeviceCreateAgentRequiresAuth(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	r := newDeviceCreateAgentServer(t, db)

	body := `{"nickname":"Anon Bot"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

// TestDeviceCreateAgentThenApprove exercises the full integration: an
// ADMIN creates a new Agent via the device-flow endpoint, then uses the
// returned id as agent_id on the subsequent approve call. The device
// code must bind to the freshly minted identity (not the approver), and
// the consent row must record that identity too.
func TestDeviceCreateAgentThenApprove(t *testing.T) {
	db := setupApproveAgentDB(t)
	defer db.Close()
	handlers.ResetTokenCacheForTest()
	insertClient(t, db, "kanban-cli-1", "", "open-kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli-1", "INLN-INLN", "kanban:read", time.Hour)
	r := gin.New()
	r.POST("/oauth/device/create-agent", handlers.RequireAuth(db), oauth.DeviceCreateAgentHandler(db))
	r.POST("/oauth/device/approve", handlers.RequireAuth(db), oauth.DeviceApproveHandler(db))

	createBody := `{"nickname":"Inline Bot"}`
	createReq := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(createBody))
	createReq.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, createReq, db, "admin-1", "ADMIN")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	if createW.Code != http.StatusOK {
		t.Fatalf("create: expected 200, got %d: %s", createW.Code, createW.Body.String())
	}
	var created struct {
		Agent struct {
			ID string `json:"id"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(createW.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Agent.ID == "" {
		t.Fatalf("expected new agent id, got empty")
	}

	approveBody := `{"user_code":"INLN-INLN","decision":"approve","agent_id":"` + created.Agent.ID + `"}`
	approveReq := httptest.NewRequest(http.MethodPost, "/oauth/device/approve", strings.NewReader(approveBody))
	approveReq.Header.Set("Content-Type", "application/json")
	setApproveUserRole(t, approveReq, db, "admin-1", "ADMIN")
	approveW := httptest.NewRecorder()
	r.ServeHTTP(approveW, approveReq)
	if approveW.Code != http.StatusOK {
		t.Fatalf("approve: expected 200, got %d: %s", approveW.Code, approveW.Body.String())
	}

	var bound sql.NullString
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_device_codes WHERE user_code_display = 'INLN-INLN'`,
	).Scan(&bound); err != nil {
		t.Fatalf("query bound user: %v", err)
	}
	if !bound.Valid || bound.String != created.Agent.ID {
		t.Errorf("expected device code bound to %s, got %v", created.Agent.ID, bound)
	}

	var consentUser sql.NullString
	if err := db.QueryRow(
		`SELECT user_id FROM oauth_consents WHERE client_id = 'kanban-cli-1'`,
	).Scan(&consentUser); err != nil {
		t.Fatalf("consent query: %v", err)
	}
	if consentUser.String != created.Agent.ID {
		t.Errorf("expected consent for %s, got %s", created.Agent.ID, consentUser.String)
	}
}