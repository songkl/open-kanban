package oauth

import (
	"database/sql"
	"errors"
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
	AgentID  string `json:"agent_id" form:"agent_id"`
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
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_request",
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
			dc, err := ApproveDeviceCode(db, req.UserCode, bindID)
			if err != nil {
				respondDeviceApproveError(c, err)
				return
			}
			// Record consent for the bound identity so future device flows
			// for the same client auto-grant under the same identity (not
			// the human approver).
			upsertConsent(db, bindID, dc.ClientID, dc.Scope)
			c.JSON(http.StatusOK, gin.H{
				"approved":  true,
				"clientId":  dc.ClientID,
				"scope":     dc.Scope,
				"expiresAt": dc.ExpiresAt,
				"userId":    bindID,
			})
		case "deny":
			if err := DenyDeviceCode(db, req.UserCode, bindID); err != nil {
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

// DeviceLookupHandler serves GET /oauth/device/lookup?user_code=XXXX-XXXX.
// It is a public read endpoint used by the verification page to display the
// client_name and scope before the user decides. Sensitive fields like the
// device_code are NOT returned.
//
// When the caller is authenticated, the response is augmented with:
//
//   - agentSelectionRequired: bool — true when the device-flow client looks
//     like a CLI / MCP runner (heuristic on client.name + grant types). When
//     true the page renders an "Authorise as" picker.
//   - availableAgents: list — enabled AGENT users the caller is permitted to
//     bind the device code to. ADMINs see all enabled Agents; MEMBERs and
//     VIEWERs see Agents whose role is not ADMIN.
//   - defaultAgentId: string — the global oauth_device_agent_id config (if
//     any). Surfaces as the pre-selected option in the picker so single-bot
//     deployments keep working without an extra click.
func DeviceLookupHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uc := strings.ToUpper(strings.TrimSpace(c.Query("user_code")))
		if uc == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user_code is required"})
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

		client, clientErr := GetClient(db, dc.ClientID)
		clientName := ""
		if clientErr == nil {
			clientName = client.Name
		}

		resp := gin.H{
			"clientId":   dc.ClientID,
			"clientName": clientName,
			"scope":      dc.Scope,
			"expiresAt":  dc.ExpiresAt,
			"status":     dc.Status,
		}

		// Only augment the response when an authenticated approver is
		// present. Anonymous lookups (e.g. typing in the code before
		// signing in) keep the minimal shape so the page can decide
		// whether to nudge the visitor to /login first.
		if user := currentUserOrUnauthorized(c, db); user != nil && clientErr == nil {
			resp["agentSelectionRequired"] = AgentSelectionRequired(client)
			resp["availableAgents"] = listAvailableAgents(db, user)
			if def := DeviceFlowAgentID(db); def != "" {
				if agent, err := lookupAgent(db, def); err == nil && agent.Enabled && agent.Type == "AGENT" && canApproveAsAgent(user, agent) {
					resp["defaultAgentId"] = agent.ID
				}
			}
		}

		c.JSON(http.StatusOK, resp)
	}
}

// AgentSelectionRequired returns true when the OAuth client registration
// looks like an unattended CLI / MCP consumer. The heuristic mirrors the
// CLI-side `isCliLikeClientName` (cli/src/auth/commands.ts) so the warning
// surfaces inline with the device-flow prompt.
//
// The rule is intentionally narrow: only client names ending in `-cli` or
// matching the canonical open-kanban-cli / kanban-cli strings are flagged.
// First-party web clients (kanban-frontend, kanban-web, etc.) are excluded
// because their approvers want to bind to their own account.
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
		strings.HasSuffix(name, "-cli")
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

// DeviceFlowAgentID reads the oauth_device_agent_id app_config key. Returns
// an empty string when unset / unparseable so callers can fall back to the
// human approver.
func DeviceFlowAgentID(db *sql.DB) string {
	var val string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'oauth_device_agent_id'").Scan(&val); err != nil {
		return ""
	}
	return strings.TrimSpace(val)
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

// DeviceCreateAgentRequest is the body submitted by the verification page
// when the approver (ADMIN) wants to create a fresh Agent identity inline
// instead of picking from the existing list. The new Agent is inserted into
// the users table (type='AGENT', role='MEMBER') and immediately selected as
// the device-code binding target on the page.
type DeviceCreateAgentRequest struct {
	Nickname string `json:"nickname"`
	Role     string `json:"role"`
}

// DeviceCreateAgentHandler serves POST /oauth/device/create-agent. It lets
// an authenticated ADMIN approver spawn a new Agent identity directly from
// the device-flow approval page (so a CLI / MCP runner that resolved to a
// HUMAN user because the approver had no Agents yet can still finish the
// binding in one click instead of bouncing through the admin settings).
//
// The new Agent is created as enabled=true with the supplied nickname and
// role (defaulting to MEMBER). It is returned to the caller with id /
// nickname / role / type so the SPA can re-render the picker and
// pre-select the freshly minted Agent before the approver presses Approve.
//
// Non-ADMIN approvers get 403; anonymous visitors get 401; invalid input
// (missing nickname) gets 400 — mirroring the shape of the existing
// /api/v1/auth/agents endpoint so the UI can reuse the same error
// handling.
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

		c.JSON(http.StatusOK, gin.H{
			"agent": gin.H{
				"id":        agentID,
				"nickname":  nickname,
				"role":      role,
				"type":      "AGENT",
				"enabled":   true,
				"createdAt": now,
			},
		})
	}
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