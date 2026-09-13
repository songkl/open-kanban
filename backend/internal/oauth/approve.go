package oauth

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// DeviceApproveRequest is the body submitted by the verification page after
// the user types in the user_code and presses approve.
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

		switch req.Decision {
		case "approve":
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
			c.JSON(http.StatusOK, gin.H{"denied": true})
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
// When the caller is authenticated as an admin, the response also includes
// the list of enabled Agents so the device authorization page can render
// the identity selector ("Authorize as <Agent>" / "Authorize as myself").
// Non-admin callers get the same payload without the agent list — they
// cannot delegate authority to Agents they do not administer.
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

		// Best effort: pull client display name.
		var clientName string
		if client, err := GetClient(db, dc.ClientID); err == nil {
			clientName = client.Name
		}

		resp := gin.H{
			"clientId":   dc.ClientID,
			"clientName": clientName,
			"scope":      dc.Scope,
			"expiresAt":  dc.ExpiresAt,
			"status":     dc.Status,
		}

		// Surface the configured global binding (if any) so the UI can
		// pre-select it in the identity picker. Empty string is the
		// documented "no binding" sentinel — the page renders the default
		// "Authorize as myself" radio in that case.
		if agentID := DeviceFlowAgentID(db); agentID != "" && hasAgent(db, agentID) {
			resp["defaultAgentId"] = agentID
		}

		// Agent picker is admin-only: only admins can act on behalf of
		// an Agent. Anonymous lookups (the legacy unauthenticated path)
		// and non-admin sessions get the response without the list so
		// the UI can hide the selector entirely.
		if user := currentUserOrUnauthorized(c, db); user != nil && user.Role == "ADMIN" {
			if agents, err := ListSelectableAgents(db); err == nil {
				items := make([]gin.H, 0, len(agents))
				for _, a := range agents {
					items = append(items, gin.H{
						"id":       a.ID,
						"nickname": a.Nickname,
						"username": a.Username,
						"role":     a.Role,
					})
				}
				resp["agents"] = items
			}
		}

		c.JSON(http.StatusOK, resp)
	}
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
