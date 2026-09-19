package oauth

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// DeviceApproveRequest is the body submitted by the verification page after
// the user types in the user_code and presses approve. AgentID is optional:
// when set, the device code is bound to the supplied Agent identity (type='AGENT')
// instead of the human approver; otherwise the device code binds to the human
// approver (or the global oauth_device_agent_id fallback if configured).
type DeviceApproveRequest struct {
	UserCode string `json:"user_code" form:"user_code"`
	Decision string `json:"decision" form:"decision"` // "approve" | "deny"
	// AgentID is the optional Agent identity the human approver chose
	// from the device authorization page's identity selector. Empty
	// string keeps the legacy "approve as the logged-in user" path. The
	// server validates that the value (when supplied) references an
	// enabled AGENT row (plan §4.1.1): unknown / disabled / non-AGENT
	// ids surface as 400 invalid_request, and MEMBER approvers pointing
	// at ADMIN-role Agents surface as 403 forbidden.
	AgentID string `json:"agentId" form:"agentId"`
}

// DeviceVerifyPageHandler serves GET /oauth/device and renders the user
// verification page. The actual SPA page is delivered by the frontend; this
// handler exists for backwards compatibility and direct rendering.
//
// The JSON API below is what the React page calls.
func DeviceApproveHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req DeviceApproveRequest
		if err := c.ShouldBind(&req); err != nil {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: "user_code and decision are required",
			})
			return
		}
		req.UserCode = strings.ToUpper(strings.TrimSpace(req.UserCode))
		if req.UserCode == "" {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: "user_code is required",
			})
			return
		}

		user := currentUserOrUnauthorized(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":             "unauthenticated",
				"error_description": "You must be logged in to approve the request",
			})
			return
		}

		// Resolve the identity that will own the device code:
		//   1. explicit agent_id on the request (validated against enabled AGENT users)
		//   2. global oauth_device_agent_id config (legacy single-bot deployments)
		//   3. the human approver (default — preserves backwards compatibility)
		//
		// Members / Viewers may only bind to themselves or to non-ADMIN-role
		// Agents; ADMINs may bind to any enabled Agent. Unknown / disabled /
		// non-AGENT ids return 400 invalid_request.
		bindID := user.ID
		if req.AgentID != "" {
			resolved, err := resolveAgentIDForApprover(db, req.AgentID, user)
			if err != nil {
				status := http.StatusBadRequest
				errorCode := "invalid_request"
				if err.Error() == "not allowed to approve as this Agent" {
					status = http.StatusForbidden
					errorCode = "forbidden"
				}
				c.JSON(status, models.OAuthErrorResponse{
					Error:            errorCode,
					ErrorDescription: err.Error(),
				})
				return
			}
			bindID = resolved
		} else if global := DeviceFlowAgentID(db); global != "" {
			if agent, err := lookupAgent(db, global); err == nil && agent.Enabled && agent.Type == "AGENT" {
				// Honour the global default only when the approver is allowed
				// to act on it. A MEMBER cannot have their device flow
				// silently rebound to an ADMIN-role Agent.
				if canApproveAsAgent(user, agent) {
					bindID = agent.ID
				}
			}
		}

		switch req.Decision {
		case "approve":
			// Plan §4.1.4 (s-1112.5): when admins have flipped
			// oauth_device_require_agent_selection to "1", approvals
			// that would bind to a HUMAN row are rejected with
			// 400 invalid_request unless the approver is themselves
			// type='AGENT'. This gates the device-flow surface so
			// `kanban run` / other CLI consumers cannot ride on a
			// human approver's identity. The check runs before the
			// LookupAgent gate so the response shape stays consistent
			// with the rest of the agent-binding contract.
			if req.AgentID == "" && DeviceFlowAgentID(db) == "" && DeviceFlowRequiresAgentSelection(db) && user.Type != "AGENT" {
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_request",
					ErrorDescription: "agent_id is required: server requires an Agent identity for device-flow approvals",
				})
				return
			}
			// Phase 1 of the device-flow agent-selection plan treats
			// the explicit agent_id as privileged: it must resolve to
			// an enabled AGENT row, and ADMIN-role Agents are reserved
			// for ADMIN approvers. Plan §4.1.1 wants 400 for unknown /
			// disabled / non-AGENT ids and 403 for MEMBER-approver +
			// ADMIN-role Agent.
			if req.AgentID != "" {
				if _, lookupErr := LookupAgent(db, req.AgentID, user.Role); lookupErr != nil {
					respondDeviceApproveAgentError(c, lookupErr)
					return
				}
			}
			dc, err := ApproveDeviceCode(db, req.UserCode, user.ID, req.AgentID)
			if err != nil {
				respondDeviceApproveError(c, err)
				return
			}
			// Record consent for this client/scope so future requests
			// auto-grant. Consent is keyed on the BOUND identity (the
			// Agent when one was selected) so the next device flow that
			// resolves to the same Agent pre-populates automatically —
			// when an admin delegates to a different Agent, the new
			// Agent's row is created instead. (plan §4.1.1, §4.4)
			boundID := bindUserForResponse(dc.UserID, user.ID)
			upsertConsent(db, boundID, dc.ClientID, dc.Scope)
			// Audit row when a human approver delegates to an Agent.
			// Actor (user_id) = the human approver, target (target_id)
			// = the bound Agent, target_type = DEVICE so the
			// activities.action CHECK permits the new value. (plan
			// §4.1.1 + §4.4)
			if boundID != user.ID {
				logDeviceApproveActivity(db, user.ID, boundID, dc.ClientID, c.ClientIP())
			}
			c.JSON(http.StatusOK, gin.H{
				"approved":  true,
				"clientId":  dc.ClientID,
				"scope":     dc.Scope,
				"expiresAt": dc.ExpiresAt,
				"boundTo":   boundID,
			})
		case "deny":
			// Mirror the approve path's agent_id validation so a deny
			// attempt with a structurally invalid id surfaces the same
			// 400/403 contract the device page expects (plan §4.1.1).
			if req.AgentID != "" {
				if _, lookupErr := LookupAgent(db, req.AgentID, user.Role); lookupErr != nil {
					respondDeviceApproveAgentError(c, lookupErr)
					return
				}
			}
			if err := DenyDeviceCode(db, req.UserCode, user.ID, req.AgentID); err != nil {
				respondDeviceApproveError(c, err)
				return
			}
			c.JSON(http.StatusOK, gin.H{"denied": true, "userId": bindID})
		default:
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: "decision must be 'approve' or 'deny'",
			})
		}
	}
}

// bindUserForResponse labels the bound identity for the JSON response so
// the UI can render "Approved as <nickname>" without an extra roundtrip.
// We surface the bound user id when it differs from the approver so the
// page can call attention to the delegation; equal ids fall through to
// the approver's id, which matches the historical response shape.
func bindUserForResponse(bound *string, approverID string) string {
	if bound == nil || *bound == "" {
		return approverID
	}
	return *bound
}

// DeviceLookupHandler serves GET /oauth/device/lookup?code=XXXX-XXXX (or the
// legacy ?user_code= alias) and returns the client_name and scope metadata
// for the verification page. Sensitive fields like the device_code are NOT
// returned.
//
// The response carries two plan-§4.1.2 affordances for the
// authorization page:
//
//   - `agent_selection_required` (bool): true when the device flow's
//     OAuth client looks like a CLI / MCP consumer, so the page should
//     render the Agent-identity picker. See IsAgentSelectionRequired
//     for the full heuristic.
//   - `available_agents` (array): the Agent identities the caller is
//     allowed to delegate to. ADMIN callers see every enabled Agent;
//     MEMBER / VIEWER callers see only non-ADMIN-role Agents; anonymous
//     callers get an empty list (the picker is hidden).
//
// The list is always emitted as `[]` (never `null`) so the frontend can
// iterate the field unconditionally — see CLAUDE.md "Prefer returning
// empty arrays `[]` over `null` for list responses".
func DeviceLookupHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Prefer the modern `code` parameter that matches
		// verification_uri_complete; keep `user_code` as a fallback so
		// older clients / saved links still work.
		uc := strings.ToUpper(strings.TrimSpace(c.Query("code")))
		if uc == "" {
			uc = strings.ToUpper(strings.TrimSpace(c.Query("user_code")))
		}
		if uc == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "code is required"})
			return
		}
		dc, err := findDeviceCodeByUserCode(db, uc)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "user_code not recognised"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if time.Now().After(dc.ExpiresAt) {
			c.JSON(http.StatusGone, gin.H{"error": "code expired"})
			return
		}

		// Pull the client record so we can both surface its display
		// name AND evaluate the CLI-detection heuristic for
		// agent_selection_required. Best effort: a missing client row
		// (shouldn't happen because the device_codes.client_id is
		// FOREIGN KEYed) defaults the name to "" and the CLI flag to
		// false so the page keeps rendering.
		var (
			client    *models.OAuthClient
			clientErr error
		)
		client, clientErr = GetClient(db, dc.ClientID)
		clientName := ""
		if clientErr == nil && client != nil {
			clientName = client.Name
		}

		resp := gin.H{
			"clientId":   dc.ClientID,
			"clientName": clientName,
			"scope":      dc.Scope,
			"expiresAt":  dc.ExpiresAt,
			"status":     dc.Status,
			// plan §4.1.2: surface the CLI heuristic so the page can
			// flip the identity picker on for `kanban run` / MCP
			// clients. False when the client row can't be read so we
			// don't accidentally hide the picker on a transient DB
			// blip.
			//
			// Both the snake_case wire name and the camelCase alias
			// are emitted: the worktree SPA reads the camelCase key,
			// older / external callers read the snake_case one.
			"agent_selection_required": IsAgentSelectionRequired(client),
			"agentSelectionRequired":   IsAgentSelectionRequired(client),
		}

		// Surface the configured global binding (if any) so the UI can
		// pre-select it in the identity picker. Empty string is the
		// documented "no binding" sentinel — the page renders the default
		// "Authorize as myself" radio in that case.
		if agentID := DeviceFlowAgentID(db); agentID != "" && hasAgent(db, agentID) {
			resp["defaultAgentId"] = agentID
		}

		// plan §4.1.2: visible-Agent list filtered by caller role.
		// Anonymous lookups get an empty slice (the picker hides
		// itself); MEMBER / VIEWER callers see only non-ADMIN-role
		// Agents so they cannot delegate outside their own authority
		// tier; ADMIN callers see every enabled Agent. Reuse the
		// shared helper that backs GET /oauth/device/agents so the
		// two endpoints stay in lockstep.
		availableAgents := []gin.H{}
		if user := currentUserOrUnauthorized(c, db); user != nil {
			if agents, err := listSelectableAgentsForRole(db, user.Role); err == nil {
				items := make([]gin.H, 0, len(agents))
				for _, a := range agents {
					items = append(items, gin.H{
						"id":       a.ID,
						"nickname": a.Nickname,
						"username": a.Username,
						"role":     a.Role,
					})
				}
				availableAgents = items
			}
		}
		resp["available_agents"] = availableAgents
		// camelCase alias consumed by the worktree SPA's identity
		// picker (see the agentSelectionRequired comment above).
		resp["availableAgents"] = availableAgents

		c.JSON(http.StatusOK, resp)
	}
}

// AgentSelectionRequired returns true when the OAuth client registration
// looks like an unattended CLI / MCP consumer. The heuristic mirrors the
// CLI-side `isCliLikeClientName` (cli/src/auth/commands.ts) so the warning
// surfaces inline with the device-flow prompt.
//
// The rule covers both `-cli` and `-mcp` suffixes — the canonical CLI
// (`open-kanban-cli`, `kanban-cli`) and the MCP server / CLI client
// registration name (`open-kanban-mcp`) all land on this path so the
// approval page renders the Agent identity picker. First-party web
// clients (kanban-frontend, kanban-web, etc.) are excluded because their
// approvers want to bind to their own account.
func AgentSelectionRequired(client *models.OAuthClient) bool {
	if client == nil {
		return false
	}
	name := strings.ToLower(strings.TrimSpace(client.Name))
	if name == "" {
		return false
	}
	return name == "kanban-cli" ||
		name == "open-kanban-cli" ||
		name == "open-kanban-mcp" ||
		strings.HasSuffix(name, "-cli") ||
		strings.HasSuffix(name, "-mcp")
}

// AgentSelectionRequiredForTest is the white-box hook the agent-selection
// table-driven test uses to exercise AgentSelectionRequired without
// spinning up a full OAuthClient constructor.
func AgentSelectionRequiredForTest(client *models.OAuthClient) bool {
	return AgentSelectionRequired(client)
}

// resolveAgentIDForApprover validates the supplied agent_id and returns
// the resolved user id. The caller must be allowed to act on the Agent
// (ADMIN: any Agent; MEMBER / VIEWER: non-ADMIN-role Agents only).
func resolveAgentIDForApprover(db *sql.DB, agentID string, approver *models.User) (string, error) {
	id := strings.TrimSpace(agentID)
	if id == "" {
		return "", errors.New("agent_id is empty")
	}
	agent, err := lookupAgent(db, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("unknown agent_id")
		}
		return "", err
	}
	if !agent.Enabled {
		return "", errors.New("agent is disabled")
	}
	if agent.Type != "AGENT" {
		return "", errors.New("target user is not an Agent")
	}
	if !canApproveAsAgent(approver, agent) {
		return "", errors.New("not allowed to approve as this Agent")
	}
	return agent.ID, nil
}

// lookupAgent fetches a user row by id.
func lookupAgent(db *sql.DB, id string) (*models.User, error) {
	var u models.User
	var avatar sql.NullString
	var lastActive sql.NullTime
	err := db.QueryRow(
		`SELECT id, username, nickname, avatar, type, role, enabled, created_at, updated_at, last_active_at
		 FROM users WHERE id = ?`,
		id,
	).Scan(&u.ID, &u.Username, &u.Nickname, &avatar, &u.Type, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt, &lastActive)
	if err != nil {
		return nil, err
	}
	if avatar.Valid {
		u.Avatar = avatar.String
	}
	if lastActive.Valid {
		t := lastActive.Time
		u.LastActiveAt = &t
	}
	return &u, nil
}

// listAvailableAgents returns enabled AGENT users the supplied approver is
// permitted to act on. The list is ordered by created_at DESC so newly
// created Agents surface first. Returns an empty slice (not nil) when no
// Agents are visible so the JSON encoder emits [].
func listAvailableAgents(db *sql.DB, approver *models.User) []gin.H {
	out := []gin.H{}
	if approver == nil {
		return out
	}
	rows, err := db.Query(
		`SELECT id, nickname, avatar, role FROM users
		 WHERE type = 'AGENT' AND enabled = 1
		   AND (role <> 'ADMIN' OR ? = 'ADMIN')
		 ORDER BY created_at DESC`,
		approver.Role,
	)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id, nickname, role string
		var avatar sql.NullString
		if err := rows.Scan(&id, &nickname, &avatar, &role); err != nil {
			continue
		}
		entry := gin.H{
			"id":       id,
			"nickname": nickname,
			"role":     role,
		}
		if avatar.Valid {
			entry["avatar"] = avatar.String
		}
		out = append(out, entry)
	}
	return out
}

// canApproveAsAgent encodes the visibility rule: ADMINs may authorise as
// any enabled Agent; MEMBERs and VIEWERs may only authorise as Agents whose
// role is not ADMIN. Centralised so both resolveAgentIDForApprover and
// listAvailableAgents apply the same gate.
func canApproveAsAgent(approver *models.User, agent *models.User) bool {
	if approver == nil || agent == nil {
		return false
	}
	if approver.Role == "ADMIN" {
		return true
	}
	return agent.Role != "ADMIN"
}

// upsertConsent records the user+client+scope consent so subsequent device
// flows for the same client can pre-populate the approval.
func upsertConsent(db *sql.DB, userID, clientID, scope string) {
	// Portable upsert via REPLACE INTO (works on both MySQL and
	// SQLite). The UNIQUE (user_id, client_id) constraint on
	// oauth_consents makes this atomic. No FK references
	// oauth_consents.id so the row id rotating on update is safe.
	_, _ = db.Exec(
		`REPLACE INTO oauth_consents (id, user_id, client_id, scope, granted_at)
		 VALUES (?, ?, ?, ?, ?)`,
		generateOpaqueID(), userID, clientID, scope, time.Now(),
	)
}

// logDeviceApproveActivity records the audit trail for a device-flow
// approval where a human approver delegated the device code to an
// Agent identity (plan §4.1.1 + §4.4). The row is written directly
// instead of going through handlers.LogActivity to keep the oauth
// package dependency-free (handlers imports oauth, not the other way
// around). Actor=user_id (the human approver), target_id = bound
// Agent, target_type = DEVICE.
//
// A best-effort write — any DB failure is logged via slog and
// swallowed so the approval response still succeeds.
func logDeviceApproveActivity(db *sql.DB, approverID, agentID, clientID, ipAddress string) {
	_, err := db.Exec(
		`INSERT INTO activities
		 (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at)
		 VALUES (?, ?, 'DEVICE_APPROVE', 'DEVICE', ?, ?, ?, ?, 'web', ?)`,
		generateOpaqueID(), approverID, agentID, clientID,
		"device_code approved for client="+clientID, ipAddress, time.Now(),
	)
	if err != nil {
		slog.Error("failed to record DEVICE_APPROVE activity",
			"error", err,
			"approver_id", approverID,
			"agent_id", agentID,
			"client_id", clientID,
		)
	}
}

// respondDeviceApproveAgentError maps an *AgentLookupError to the
// OAuth-style response contract documented in plan §4.1.1: 400
// invalid_request for structurally unusable ids and 403 forbidden for
// role-gated delegations. Non-AgentLookupError inputs fall through to
// the generic 500 server_error so unexpected DB failures don't get
// mis-categorised as user errors.
func respondDeviceApproveAgentError(c *gin.Context, err error) {
	var lookupErr *AgentLookupError
	if errors.As(err, &lookupErr) {
		switch lookupErr.Reason {
		case AgentLookupForbidden:
			c.JSON(http.StatusForbidden, gin.H{
				"error":             "forbidden",
				"error_description": lookupErr.Error(),
			})
			return
		default:
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: lookupErr.Error(),
			})
			return
		}
	}
	c.JSON(http.StatusInternalServerError, gin.H{
		"error":             "server_error",
		"error_description": err.Error(),
	})
}

// respondDeviceApproveError maps internal errors to OAuth-style JSON.
func respondDeviceApproveError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		c.JSON(http.StatusNotFound, models.OAuthErrorResponse{
			Error:            "invalid_request",
			ErrorDescription: "user_code not recognised or no longer pending",
		})
	case strings.Contains(err.Error(), "expired"):
		c.JSON(http.StatusGone, models.OAuthErrorResponse{
			Error:            "expired_token",
			ErrorDescription: "user_code has expired",
		})
	default:
		c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
			Error:            "invalid_request",
			ErrorDescription: err.Error(),
		})
	}
}

// currentUserOrUnauthorized resolves the bearer user using the same logic as
// handlers.getCurrentUser when RequireAuth has already populated the context.
func currentUserOrUnauthorized(c *gin.Context, db *sql.DB) *models.User {
	if v, ok := c.Get("user"); ok {
		if u, ok := v.(*models.User); ok {
			return u
		}
	}
	return nil
}
// DeviceCreateAgentRequest is the body submitted by the verification page
// when the approver (ADMIN) wants to create a fresh Agent identity inline
// instead of picking from the existing list. The new Agent is inserted into
// the users table (type='AGENT') and immediately selected as the device-code
// binding target on the page.
//
// BoardGrants is the s-1253 extension that lets the approver attach
// explicit (boardId, access) rows at creation time — without it the inline
// create would mint an agent with zero board access, leaving the runner
// useless until somebody opens the settings page to grant access manually.
// When omitted the handler inserts no board permissions, matching the new
// "no implicit broad grants" contract introduced for the
// /api/v1/auth/agents endpoint.
type DeviceCreateAgentRequest struct {
	Nickname    string             `json:"nickname"`
	Role        string             `json:"role"`
	BoardGrants []BoardAccessGrant `json:"boardGrants"`
}

// BoardAccessGrant is the local mirror of the type the handlers package
// uses for the same field; the two definitions stay in sync (same field
// names, same access enum) so a UI that targets either endpoint can reuse
// the same JSON shape. We duplicate the type because handlers already
// imports oauth (for the signer), so we cannot import handlers from here
// without an import cycle.
type BoardAccessGrant struct {
	BoardID string `json:"boardId"`
	Access  string `json:"access"`
}

// resolveDeviceCreateAgentBoardGrants is the device-flow mirror of
// handlers.ResolveBoardGrants. The contract is identical (unknown access →
// 400, unknown board → 400, dupes collapse by boardId, first occurrence
// wins) so the UI can reuse the same payload shape on both endpoints; the
// implementation is duplicated rather than imported because handlers
// already imports oauth (for the signer used inside auth_handlers.go), and
// the reverse import would create a cycle.
func resolveDeviceCreateAgentBoardGrants(db *sql.DB, callerID, newAgentID string, grants []BoardAccessGrant) (int, error) {
	if len(grants) == 0 {
		return 0, nil
	}
	seen := make(map[string]string, len(grants))
	for _, g := range grants {
		if g.BoardID == "" || g.Access == "" {
			return 0, fmt.Errorf("invalid boardGrants entry: boardId and access are required")
		}
		switch g.Access {
		case "READ", "WRITE", "ADMIN":
		default:
			return 0, fmt.Errorf("invalid access %q for board %q", g.Access, g.BoardID)
		}
		if _, dup := seen[g.BoardID]; dup {
			continue
		}
		seen[g.BoardID] = g.Access
	}
	if len(seen) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	existing, err := db.Query(
		"SELECT id FROM boards WHERE deleted = false AND id IN ("+placeholders+")", args...,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to verify boards: %w", err)
	}
	found := make(map[string]struct{}, len(ids))
	for existing.Next() {
		var id string
		if err := existing.Scan(&id); err == nil {
			found[id] = struct{}{}
		}
	}
	existing.Close()
	var missing []string
	for _, id := range ids {
		if _, ok := found[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return 0, fmt.Errorf("unknown board ids: %v", missing)
	}
	permArgs := make([]interface{}, 0, len(ids)*9)
	placeholders = ""
	for i, id := range ids {
		if i > 0 {
			placeholders += ", "
		}
		placeholders += "(?, ?, ?, ?, ?, NULL, NULL, NULL, '')"
		permArgs = append(permArgs, generateOpaqueID(), newAgentID, id, seen[id], callerID)
	}
	if _, err := db.Exec(
		"INSERT INTO board_permissions (id, user_id, board_id, access, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes) VALUES "+placeholders,
		permArgs...,
	); err != nil {
		return 0, fmt.Errorf("failed to insert board_permissions: %w", err)
	}
	return len(ids), nil
}

// DeviceCreateAgentHandler serves POST /oauth/device/create-agent. It lets
// an authenticated ADMIN approver spawn a new Agent identity directly from
// the device-flow approval page (so a CLI / MCP runner that resolved to a
// HUMAN user because the approver had no Agents yet can still finish the
// binding in one click instead of bouncing through the admin settings).
//
// The new Agent is created as enabled=true with the supplied nickname and
// role (defaulting to MEMBER). It is returned to the caller with id /
// nickname / role / type so the SPA can re-render the picker and pre-select
// the freshly minted Agent before the approver presses Approve.
//
// Non-ADMIN approvers get 403; anonymous visitors get 401; invalid input
// (missing nickname) gets 400 — mirroring the shape of the existing
// /api/v1/auth/agents endpoint so the UI can reuse the same error handling.
func DeviceCreateAgentHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := currentUserOrUnauthorized(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":             "unauthenticated",
				"error_description": "You must be logged in to create an Agent",
			})
			return
		}
		if user.Role != "ADMIN" {
			c.JSON(http.StatusForbidden, gin.H{
				"error":             "forbidden",
				"error_description": "Only admin approvers can create Agent identities from the device-flow page",
			})
			return
		}

		var req DeviceCreateAgentRequest
		if err := c.ShouldBind(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":             "invalid_request",
				"error_description": "request body must be JSON with a non-empty nickname",
			})
			return
		}
		nickname := strings.TrimSpace(req.Nickname)
		if nickname == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":             "invalid_request",
				"error_description": "nickname is required",
			})
			return
		}

		role := strings.ToUpper(strings.TrimSpace(req.Role))
		if role == "" {
			role = "MEMBER"
		}
		if role != "ADMIN" && role != "MEMBER" && role != "VIEWER" {
			role = "MEMBER"
		}

		agentID := generateOpaqueID()
		now := time.Now()
		if _, err := db.Exec(
			`INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at, last_active_at)
			 VALUES (?, ?, ?, '', 'AGENT', ?, 1, ?, ?, ?)`,
			agentID, nickname, nickname, role, now, now, now,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":             "server_error",
				"error_description": err.Error(),
			})
			return
		}

		// s-1253: per-board role selection at creation time. The local
		// resolveDeviceCreateAgentBoardGrants helper mirrors
		// handlers.ResolveBoardGrants (see the comment on that function
		// for why the duplication exists). On failure the user row is
		// rolled back so the approver does not end up with an orphan
		// agent whose name+id is shown in the picker but cannot reach
		// any board.
		var grantedCount int
		if len(req.BoardGrants) > 0 {
			var gErr error
			grantedCount, gErr = resolveDeviceCreateAgentBoardGrants(db, user.ID, agentID, req.BoardGrants)
			if gErr != nil {
				if _, delErr := db.Exec(`DELETE FROM users WHERE id = ?`, agentID); delErr != nil {
					log.Printf("[DeviceCreateAgent] failed to roll back orphan agent %s: %v", agentID, delErr)
				}
				c.JSON(http.StatusBadRequest, gin.H{
					"error":             "invalid_request",
					"error_description": gErr.Error(),
				})
				return
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"agent": gin.H{
				"id":           agentID,
				"nickname":     nickname,
				"role":         role,
				"type":         "AGENT",
				"enabled":      true,
				"createdAt":    now,
				"grantedCount": grantedCount,
			},
		})
	}
}
