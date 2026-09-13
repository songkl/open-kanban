package oauth

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// DeviceAgentsHandler serves GET /oauth/device/agents and returns the list
// of enabled Agent identities the caller is allowed to delegate device
// codes to. The endpoint exists so the device authorization page can
// re-fetch the selectable Agent list after the human changes scope or
// filter without round-tripping through /oauth/device/lookup (plan
// §4.1.3).
//
// Auth: RequireAuth is applied at the route layer; this handler assumes
// the caller is already authenticated and reads the user from the gin
// context (same pattern as DeviceApproveHandler).
//
// Visibility rule (plan §4.1.2 + §4.1.3):
//   - ADMIN sees every enabled Agent.
//   - MEMBER / VIEWER see enabled Agents whose role is not ADMIN, so a
//     human approver can only delegate to Agents that match their own
//     authority tier.
//
// Payload mirrors the `available_agents` slice already emitted by
// DeviceLookupHandler so the frontend can reuse the rendering path:
//   { "agents": [{id, nickname, username, role}, ...] }
//
// The response is always 200 with an (empty) array even when the
// caller has no visible Agents — an admin can still authorise as
// themselves or deny the request, and a MEMBER with no visible
// Agents falls through to the "Myself" default.
func DeviceAgentsHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := currentUserOrUnauthorized(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":             "unauthenticated",
				"error_description": "login required to list selectable Agents",
			})
			return
		}

		agents, err := listSelectableAgentsForRole(db, user.Role)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		items := make([]gin.H, 0, len(agents))
		for _, a := range agents {
			items = append(items, gin.H{
				"id":       a.ID,
				"nickname": a.Nickname,
				"username": a.Username,
				"role":     a.Role,
			})
		}
		c.JSON(http.StatusOK, gin.H{"agents": items})
	}
}

// listSelectableAgentsForRole returns enabled AGENT users filtered by
// the visibility rule documented on DeviceAgentsHandler. Extracted as
// its own helper so the SQL stays close to ListSelectableAgents and
// can be unit-tested against the same seed data.
func listSelectableAgentsForRole(db *sql.DB, callerRole string) ([]AgentSummary, error) {
	query := `SELECT id, nickname, username, role, enabled
		 FROM users
		 WHERE type = 'AGENT' AND enabled = 1`
	args := []interface{}{}
	// Non-admin callers cannot see ADMIN-role Agents; the Phase-1 rule
	// in plan §4.1.2 keeps MEMBER/VIEWER delegations inside their own
	// authority tier.
	if callerRole != "ADMIN" {
		query += ` AND role <> 'ADMIN'`
	}
	query += ` ORDER BY created_at DESC`

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AgentSummary, 0, 8)
	for rows.Next() {
		var a AgentSummary
		if err := rows.Scan(&a.ID, &a.Nickname, &a.Username, &a.Role, &a.Enabled); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
