package oauth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// AdminOAuthClient is the admin-facing representation of a registered client.
type AdminOAuthClient struct {
	ID                      string    `json:"id"`
	ClientID                string    `json:"clientId"`
	Name                    string    `json:"name"`
	RedirectURIs            []string  `json:"redirectUris"`
	GrantTypes              []string  `json:"grantTypes"`
	TokenEndpointAuthMethod string    `json:"tokenEndpointAuthMethod"`
	Scopes                  []string  `json:"scopes"`
	IsFirstParty            bool      `json:"isFirstParty"`
	CreatedAt               time.Time `json:"createdAt"`
}

// ListAdminClientsHandler returns all OAuth clients (admin only).
func ListAdminClientsHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(
			`SELECT id, client_id, name, redirect_uris, grant_types,
			        token_endpoint_auth_method, scopes, is_first_party, created_at
			 FROM oauth_clients ORDER BY created_at DESC`,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		out := []AdminOAuthClient{}
		for rows.Next() {
			var (
				a          AdminOAuthClient
				redirects  string
				grants     string
				scopes     string
				firstParty bool
			)
			if err := rows.Scan(&a.ID, &a.ClientID, &a.Name, &redirects, &grants,
				&a.TokenEndpointAuthMethod, &scopes, &firstParty, &a.CreatedAt); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			_ = json.Unmarshal([]byte(redirects), &a.RedirectURIs)
			_ = json.Unmarshal([]byte(grants), &a.GrantTypes)
			_ = json.Unmarshal([]byte(scopes), &a.Scopes)
			a.IsFirstParty = firstParty
			out = append(out, a)
		}
		c.JSON(http.StatusOK, gin.H{"clients": out})
	}
}

// DeleteAdminClientHandler removes a registered client and revokes all of its
// outstanding refresh tokens (cascade).
func DeleteAdminClientHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientID := c.Query("client_id")
		if clientID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "client_id is required"})
			return
		}
		res, err := db.Exec(`DELETE FROM oauth_clients WHERE client_id = ?`, clientID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "client not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": clientID})
	}
}

// ListConsentsHandler returns the current user's authorised clients.
func ListConsentsHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := currentUserOrUnauthorized(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		rows, err := db.Query(
			`SELECT client_id, scope, granted_at FROM oauth_consents WHERE user_id = ? ORDER BY granted_at DESC`,
			user.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		out := []gin.H{}
		for rows.Next() {
			var cid, scope string
			var grantedAt time.Time
			if err := rows.Scan(&cid, &scope, &grantedAt); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			// Attach the client display name when available.
			clientName := ""
			if client, err := GetClient(db, cid); err == nil {
				clientName = client.Name
			}
			out = append(out, gin.H{
				"clientId":   cid,
				"clientName": clientName,
				"scope":      scope,
				"grantedAt":  grantedAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"consents": out})
	}
}

// RevokeConsentHandler deletes the user's consent row for a client. Any
// outstanding refresh tokens belonging to that user+client are also revoked.
func RevokeConsentHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := currentUserOrUnauthorized(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		clientID := strings.TrimSpace(c.Query("client_id"))
		if clientID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "client_id is required"})
			return
		}
		res, err := db.Exec(`DELETE FROM oauth_consents WHERE user_id = ? AND client_id = ?`, user.ID, clientID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "consent not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		n, _ := res.RowsAffected()
		_, _ = db.Exec(
			`UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
			time.Now(), user.ID, clientID,
		)
		c.JSON(http.StatusOK, gin.H{"revoked": clientID, "existed": n > 0})
	}
}

// GetOAuthConfigHandler returns the current OAuth config map for the admin
// settings UI.
func GetOAuthConfigHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		m, err := GetConfigMap(db)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Surface the canonical key list with descriptions for the UI.
		keys := []gin.H{}
		for _, k := range DefaultConfig() {
			keys = append(keys, gin.H{
				"key":         k.Key,
				"value":       m[k.Key],
				"default":     k.DefaultVal,
				"description": k.Description,
			})
		}
		c.JSON(http.StatusOK, gin.H{"config": keys, "dynamicRegistrationEnabled": DynamicRegistrationEnabled(db)})
	}
}

// UpdateOAuthConfigRequest is the body for PUT /api/v1/auth/oauth/config.
type UpdateOAuthConfigRequest struct {
	Updates map[string]string `json:"updates"`
}

// UpdateOAuthConfigHandler updates OAuth config keys.
func UpdateOAuthConfigHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req UpdateOAuthConfigRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
			return
		}
		if len(req.Updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "no updates provided"})
			return
		}
		for k, v := range req.Updates {
			if err := SetConfig(db, k, v); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "key": k})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"updated": len(req.Updates)})
	}
}
