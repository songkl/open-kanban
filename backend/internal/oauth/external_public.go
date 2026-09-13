package oauth

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// PublicOAuthProvider is the wire shape returned by the public
// GET /api/v1/auth/external/providers endpoint. It is intentionally
// narrower than the admin AdminOAuthProvider (plan §4.2): the login
// page only needs the buttons it has to render — slug, display name,
// kind, render order, the OAuth client_id, the scopes to send to
// the IdP, and the auth_endpoint used to build the authorize URL.
//
// Critically, the encrypted client_secret, the admin-only audit
// fields, and the disabled toggle (the public surface only returns
// enabled rows anyway) are NOT exposed. Keeping the public shape
// distinct from the admin shape means a future column added to
// the admin shape cannot accidentally leak through the login
// page render.
type PublicOAuthProvider struct {
	ProviderID   string `json:"providerId"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	Position     int    `json:"position"`
	ClientID     string `json:"clientId"`
	Scopes       string `json:"scopes"`
	AuthEndpoint string `json:"authEndpoint"`
}

// ListEnabledExternalProvidersHandler serves
// GET /api/v1/auth/external/providers. The endpoint is public —
// no RequireAuth — because the /login page renders before any
// user is authenticated (plan §4.2).
//
// The query is gated by oauth_providers.enabled=1 so a disabled
// row never appears in the public list; rows are ordered by
// position ASC, created_at DESC so the admin UI's drag-to-reorder
// intent survives a public re-fetch (the tie-breaker keeps the
// order stable when two rows share a position).
//
// The response body always returns `providers: []` rather than
// `null` when the database has no enabled rows, so the frontend
// can use `providers.length` directly without a null check.
func ListEnabledExternalProvidersHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(
			`SELECT provider_id, name, type, position, client_id, scopes, auth_endpoint
			   FROM oauth_providers
			  WHERE enabled = 1
			  ORDER BY position ASC, created_at DESC`,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()

		out := []PublicOAuthProvider{}
		for rows.Next() {
			var p PublicOAuthProvider
			if err := rows.Scan(
				&p.ProviderID, &p.Name, &p.Type, &p.Position,
				&p.ClientID, &p.Scopes, &p.AuthEndpoint,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			out = append(out, p)
		}
		if err := rows.Err(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"providers": out})
	}
}