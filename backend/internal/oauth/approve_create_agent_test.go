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

	"open-kanban/internal/handlers"
	"open-kanban/internal/oauth"
)

// setupCreateAgentDB extends setupApproveDB with the boards /
// board_permissions tables the inline device-flow agent creation path
// writes to when boardGrants are supplied (s-1253).
func setupCreateAgentDB(t *testing.T) *sql.DB {
	t.Helper()
	db := setupApproveDB(t)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS boards (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT DEFAULT '',
			deleted BOOLEAN DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS board_permissions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			board_id TEXT NOT NULL,
			access TEXT DEFAULT 'READ' CHECK(access IN ('READ','WRITE','ADMIN')),
			granted_by_user_id TEXT,
			expires_at DATETIME,
			revoked_at DATETIME,
			revoked_by_user_id TEXT,
			notes TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func newCreateAgentServer(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.POST("/oauth/device/create-agent",
		handlers.RequireAuth(db),
		oauth.DeviceCreateAgentHandler(db),
	)
	return r
}

func countAgents(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users WHERE type = 'AGENT'`).Scan(&n); err != nil {
		t.Fatalf("count agents: %v", err)
	}
	return n
}

func TestDeviceCreateAgent_HappyPathNoGrants(t *testing.T) {
	db := setupCreateAgentDB(t)
	defer db.Close()
	r := newCreateAgentServer(t, db)

	body := `{"nickname":"runner-bot","role":"MEMBER"}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "admin-1") // ADMIN by default
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Agent struct {
			ID           string `json:"id"`
			Nickname     string `json:"nickname"`
			Role         string `json:"role"`
			Type         string `json:"type"`
			Enabled      bool   `json:"enabled"`
			GrantedCount int    `json:"grantedCount"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Agent.ID == "" {
		t.Fatal("expected a non-empty agent id")
	}
	if resp.Agent.Nickname != "runner-bot" || resp.Agent.Role != "MEMBER" || resp.Agent.Type != "AGENT" || !resp.Agent.Enabled {
		t.Errorf("unexpected agent payload: %+v", resp.Agent)
	}
	if resp.Agent.GrantedCount != 0 {
		t.Errorf("expected grantedCount=0 without boardGrants, got %d", resp.Agent.GrantedCount)
	}
	if got := countAgents(t, db); got != 1 {
		t.Errorf("expected 1 agent row, got %d", got)
	}
}

func TestDeviceCreateAgent_WithBoardGrants(t *testing.T) {
	db := setupCreateAgentDB(t)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Board 1'), ('b2', 'Board 2')`); err != nil {
		t.Fatalf("seed boards: %v", err)
	}
	r := newCreateAgentServer(t, db)

	body := `{"nickname":"scoped-bot","role":"VIEWER","boardGrants":[
		{"boardId":"b1","access":"READ"},
		{"boardId":"b2","access":"WRITE"}
	]}`
	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "admin-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Agent struct {
			ID           string `json:"id"`
			GrantedCount int    `json:"grantedCount"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Agent.GrantedCount != 2 {
		t.Errorf("expected grantedCount=2, got %d", resp.Agent.GrantedCount)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions WHERE user_id = ?`, resp.Agent.ID).Scan(&n); err != nil {
		t.Fatalf("count grants: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 board_permissions rows, got %d", n)
	}
	// granted_by_user_id is stamped with the calling admin.
	var grantedBy sql.NullString
	if err := db.QueryRow(`SELECT granted_by_user_id FROM board_permissions WHERE user_id = ? AND board_id = 'b1'`, resp.Agent.ID).Scan(&grantedBy); err != nil {
		t.Fatalf("query grant: %v", err)
	}
	if !grantedBy.Valid || grantedBy.String != "admin-1" {
		t.Errorf("expected granted_by_user_id=admin-1, got %+v", grantedBy)
	}
}

func TestDeviceCreateAgent_NonAdminForbidden(t *testing.T) {
	db := setupCreateAgentDB(t)
	defer db.Close()
	r := newCreateAgentServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent",
		strings.NewReader(`{"nickname":"nope"}`))
	req.Header.Set("Content-Type", "application/json")
	setApproveUserRole(req, db, "member-1", "MEMBER")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
	if got := countAgents(t, db); got != 0 {
		t.Errorf("expected no agent rows after 403, got %d", got)
	}
}

func TestDeviceCreateAgent_AnonymousUnauthorized(t *testing.T) {
	db := setupCreateAgentDB(t)
	defer db.Close()
	r := newCreateAgentServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent",
		strings.NewReader(`{"nickname":"nope"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeviceCreateAgent_EmptyNicknameBadRequest(t *testing.T) {
	db := setupCreateAgentDB(t)
	defer db.Close()
	r := newCreateAgentServer(t, db)

	req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent",
		strings.NewReader(`{"nickname":"   "}`))
	req.Header.Set("Content-Type", "application/json")
	setApproveUser(req, db, "admin-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if got := countAgents(t, db); got != 0 {
		t.Errorf("expected no agent rows after 400, got %d", got)
	}
}

func TestDeviceCreateAgent_InvalidBoardGrantRollsBack(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"unknown_access", `{"nickname":"bot","boardGrants":[{"boardId":"b1","access":"SUPER"}]}`},
		{"unknown_board", `{"nickname":"bot","boardGrants":[{"boardId":"ghost","access":"READ"}]}`},
		{"empty_access", `{"nickname":"bot","boardGrants":[{"boardId":"b1","access":""}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := setupCreateAgentDB(t)
			defer db.Close()
			if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'Board 1')`); err != nil {
				t.Fatalf("seed board: %v", err)
			}
			r := newCreateAgentServer(t, db)

			req := httptest.NewRequest(http.MethodPost, "/oauth/device/create-agent", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			setApproveUser(req, db, "admin-1")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			// The handler must roll the orphan agent back so the
			// approver doesn't see a picker entry with no access.
			if got := countAgents(t, db); got != 0 {
				t.Errorf("expected orphan agent rollback, got %d agent rows", got)
			}
		})
	}
}

// TestDeviceLookup_EmitsCamelCaseAliases guards the camelCase keys the
// worktree SPA's identity picker reads (agentSelectionRequired /
// availableAgents). The snake_case wire names stay for external callers,
// but the SPA switches on the camelCase alias so both must be present.
func TestDeviceLookup_EmitsCamelCaseAliases(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-cli", "", "kanban-cli",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	insertPendingDevice(t, db, "kanban-cli", "SCEN-CAMEL", "kanban:read", time.Hour)
	seedAgentWithRole(t, db, "agent-a", "Agent A", "MEMBER", true)
	r := newApproveServer(t, db)

	resp := lookupDevice(t, r, "scen-camel")

	// agentSelectionRequired must mirror agent_selection_required.
	snake, _ := resp["agent_selection_required"].(bool)
	camel, ok := resp["agentSelectionRequired"].(bool)
	if !ok {
		t.Fatalf("expected agentSelectionRequired in lookup payload, got %v", resp)
	}
	if snake != camel {
		t.Errorf("agent_selection_required=%v but agentSelectionRequired=%v", snake, camel)
	}

	// availableAgents must mirror available_agents.
	snakeAgents, ok := resp["available_agents"].([]interface{})
	if !ok {
		t.Fatalf("expected available_agents slice, got %T", resp["available_agents"])
	}
	camelAgents, ok := resp["availableAgents"].([]interface{})
	if !ok {
		t.Fatalf("expected availableAgents alias, got %T", resp["availableAgents"])
	}
	if len(snakeAgents) != len(camelAgents) {
		t.Errorf("available_agents has %d entries but availableAgents has %d", len(snakeAgents), len(camelAgents))
	}
}
