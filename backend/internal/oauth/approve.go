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
// the user types in the user_code and presses approve.
type DeviceApproveRequest struct {
	UserCode string `json:"user_code" form:"user_code"`
	Decision string `json:"decision" form:"decision"` // "approve" | "deny"
	// AgentID is the optional Agent identity the human approver chose
	// from the device authorization page's identity selector. Empty
	// string keeps the legacy "approve as the logged-in user" path. The
	// server validates that the value (when supplied) references an
	// enabled AGENT row; unknown ids are silently dropped and the
	// approval still binds to the human approver so a stale UI cannot
	// brick a device flow.
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
			dc, err := ApproveDeviceCode(db, req.UserCode, user.ID, req.AgentID)
			if err != nil {
				respondDeviceApproveError(c, err)
				return
			}
			// Record consent for this client/scope so future requests auto-grant.
			upsertConsent(db, user.ID, dc.ClientID, dc.Scope)
			c.JSON(http.StatusOK, gin.H{
				"approved":  true,
				"clientId":  dc.ClientID,
				"scope":     dc.Scope,
				"expiresAt": dc.ExpiresAt,
			})
		case "deny":
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
