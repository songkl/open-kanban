package oauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// AllowedProviderTypes mirrors the CHECK constraint on
// oauth_providers.type. Keep the two in sync; the API layer rejects
// any value outside this set before the SQL does, so a typo from the
// admin UI surfaces as 400 with the offending field name rather than
// the more opaque CHECK violation.
var AllowedProviderTypes = []string{
	"google", "github", "wecom", "feishu", "dingtalk", "oidc",
}

// providerIDRegex enforces the slug convention documented on
// oauth_providers.provider_id (lowercase letters / digits / dashes).
// Uniqueness is enforced by the UNIQUE index on the column itself.
var providerIDRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`)

// scopeTokenRegex matches a single scope token per plan §7.5:
// `[a-z0-9._:-]{1,64}`. Multiple tokens are joined by spaces, so the
// full scopes string is validated token-by-token.
var scopeTokenRegex = regexp.MustCompile(`^[a-z0-9._:-]{1,64}$`)

// AdminOAuthProvider is the wire shape returned by the admin provider
// CRUD endpoints. client_secret is intentionally omitted — only the
// boolean `secretSet` flag is exposed, mirroring the admin OAuth
// client settings UX where re-entry is the only way to change a
// secret after creation.
type AdminOAuthProvider struct {
	ID               string    `json:"id"`
	ProviderID       string    `json:"providerId"`
	Name             string    `json:"name"`
	Type             string    `json:"type"`
	Enabled          bool      `json:"enabled"`
	Position         int       `json:"position"`
	ClientID         string    `json:"clientId"`
	SecretSet        bool      `json:"secretSet"`
	Scopes           string    `json:"scopes"`
	AuthEndpoint     string    `json:"authEndpoint"`
	TokenEndpoint    string    `json:"tokenEndpoint"`
	UserinfoEndpoint string    `json:"userinfoEndpoint"`
	Issuer           string    `json:"issuer"`
	ExtraConfig      string    `json:"extraConfig"`
	CreatedBy        string    `json:"createdBy,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// CreateProviderRequest is the POST /api/v1/oauth/providers body.
// clientSecret is optional because public-client providers (device
// flow, PKCE-only) legitimately have no secret.
type CreateProviderRequest struct {
	ProviderID       string `json:"providerId"`
	Name             string `json:"name"`
	Type             string `json:"type"`
	Enabled          *bool  `json:"enabled"`
	Position         *int   `json:"position"`
	ClientID         string `json:"clientId"`
	ClientSecret     string `json:"clientSecret"`
	Scopes           string `json:"scopes"`
	AuthEndpoint     string `json:"authEndpoint"`
	TokenEndpoint    string `json:"tokenEndpoint"`
	UserinfoEndpoint string `json:"userinfoEndpoint"`
	Issuer           string `json:"issuer"`
	ExtraConfig      string `json:"extraConfig"`
}

// UpdateProviderRequest is the PUT /api/v1/oauth/providers/:id body.
// clientSecret is a pointer so "leave unchanged" (nil) is
// distinguishable from "set to empty string" (public-client).
type UpdateProviderRequest struct {
	Name             *string `json:"name"`
	Type             *string `json:"type"`
	Enabled          *bool   `json:"enabled"`
	Position         *int    `json:"position"`
	ClientID         *string `json:"clientId"`
	ClientSecret     *string `json:"clientSecret"`
	Scopes           *string `json:"scopes"`
	AuthEndpoint     *string `json:"authEndpoint"`
	TokenEndpoint    *string `json:"tokenEndpoint"`
	UserinfoEndpoint *string `json:"userinfoEndpoint"`
	Issuer           *string `json:"issuer"`
	ExtraConfig      *string `json:"extraConfig"`
}

// ValidateProviderPayload enforces plan §7.5 (URL schemes, scope
// tokens) plus the type allow-list and provider_id slug shape. It
// returns the offending field name in the error so the admin UI can
// point the user at the broken input.
func ValidateProviderPayload(providerID, name, ptype, clientID, scopes, authURL, tokenURL, userinfoURL, issuer, extraConfig string) error {
	providerID = strings.TrimSpace(providerID)
	if !providerIDRegex.MatchString(providerID) {
		return errors.New("providerId must match ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
	}
	if strings.TrimSpace(name) == "" {
		return errors.New("name is required")
	}
	found := false
	for _, t := range AllowedProviderTypes {
		if ptype == t {
			found = true
			break
		}
	}
	if !found {
		return errors.New("type must be one of: " + strings.Join(AllowedProviderTypes, ", "))
	}
	if strings.TrimSpace(clientID) == "" {
		return errors.New("clientId is required")
	}
	if strings.TrimSpace(scopes) != "" {
		for _, tok := range strings.Fields(scopes) {
			if !scopeTokenRegex.MatchString(tok) {
				return errors.New("scopes contains invalid token: " + tok)
			}
		}
	}
	if err := validateOptionalURL(authURL, "authEndpoint"); err != nil {
		return err
	}
	if err := validateOptionalURL(tokenURL, "tokenEndpoint"); err != nil {
		return err
	}
	if err := validateOptionalURL(userinfoURL, "userinfoEndpoint"); err != nil {
		return err
	}
	if strings.TrimSpace(issuer) != "" {
		if _, err := url.Parse(strings.TrimSpace(issuer)); err != nil {
			return errors.New("issuer is not a valid URL")
		}
	}
	if strings.TrimSpace(extraConfig) != "" {
		var probe map[string]interface{}
		if err := json.Unmarshal([]byte(extraConfig), &probe); err != nil {
			return errors.New("extraConfig must be a JSON object")
		}
	}
	if ptype == "oidc" && strings.TrimSpace(issuer) == "" {
		return errors.New("issuer is required when type is oidc")
	}
	return nil
}

// validateOptionalURL accepts the empty string (use the type's built-in
// default) or a syntactically valid http(s) URL. Plan §7.5 allows
// `http://localhost` / `http://127.0.0.1` for self-hosted testing.
func validateOptionalURL(raw, field string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New(field + " is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New(field + " must use http or https")
	}
	if u.Host == "" {
		return errors.New(field + " is missing a host")
	}
	if u.Scheme == "http" {
		host := u.Hostname()
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			return errors.New(field + " must use https (http is only allowed for localhost / 127.0.0.1)")
		}
	}
	return nil
}

// newProviderID returns a 16-byte hex id for the internal primary key,
// matching the convention used by handlers.generateID elsewhere in the
// codebase so the foreign keys and audit logs share one ID shape.
func newProviderID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

// requireAdmin resolves the caller via currentUserOrUnauthorized and
// rejects anything that isn't role=ADMIN. Centralised so every CRUD
// handler emits the exact same 401 / 403 envelope. Returns the
// *models.User so callers can read its ID without a second context
// lookup.
func requireAdmin(c *gin.Context, db *sql.DB) (*models.User, bool) {
	user := currentUserOrUnauthorized(c, db)
	if user == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
		return nil, false
	}
	if user.Role != "ADMIN" {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin role required"})
		return nil, false
	}
	return user, true
}

// scanProviderRow was an attempt to share SELECT column ordering
// between List and Get. In practice both paths want the full row
// (including the secret BLOB for the secretSet flag), so each handler
// scans directly. The helper is intentionally absent — keeping a
// half-used abstraction here would make future schema drift (adding
// a new column) harder to spot.

// ListAdminProvidersHandler serves GET /api/v1/oauth/providers.
// Secrets are redacted (secretSet reflects whether the BLOB column is
// non-NULL).
func ListAdminProvidersHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := requireAdmin(c, db); !ok {
			return
		}
		rows, err := db.Query(
			`SELECT id, provider_id, name, type, enabled, position,
			        client_id, client_secret, scopes, auth_endpoint, token_endpoint,
			        userinfo_endpoint, issuer, extra_config,
			        created_at, updated_at, created_by
			 FROM oauth_providers ORDER BY position ASC, created_at DESC`,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		out := []AdminOAuthProvider{}
		for rows.Next() {
			var (
				secret   sql.NullString
				p        AdminOAuthProvider
				createdB sql.NullString
			)
			if err := rows.Scan(
				&p.ID, &p.ProviderID, &p.Name, &p.Type, &p.Enabled, &p.Position,
				&p.ClientID, &secret, &p.Scopes, &p.AuthEndpoint, &p.TokenEndpoint,
				&p.UserinfoEndpoint, &p.Issuer, &p.ExtraConfig,
				&p.CreatedAt, &p.UpdatedAt, &createdB,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			p.SecretSet = secret.Valid && len(secret.String) > 0
			if createdB.Valid {
				p.CreatedBy = createdB.String
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

// CreateAdminProviderHandler serves POST /api/v1/oauth/providers.
func CreateAdminProviderHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := requireAdmin(c, db)
		if !ok {
			return
		}
		var req CreateProviderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
			return
		}
		req.ProviderID = strings.TrimSpace(req.ProviderID)
		if err := ValidateProviderPayload(
			req.ProviderID, req.Name, strings.TrimSpace(req.Type),
			req.ClientID, req.Scopes,
			req.AuthEndpoint, req.TokenEndpoint, req.UserinfoEndpoint,
			req.Issuer, req.ExtraConfig,
		); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		secret, err := EncryptProviderSecret([]byte(req.ClientSecret))
		if err != nil {
			if errors.Is(err, ErrProviderSecretKeyMissing) {
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"error": "OAUTH_PROVIDER_ENCRYPTION_KEY is not configured",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		enabled := 1
		if req.Enabled != nil && !*req.Enabled {
			enabled = 0
		}
		position := 0
		if req.Position != nil {
			position = *req.Position
		}
		extraConfig := strings.TrimSpace(req.ExtraConfig)
		if extraConfig == "" {
			extraConfig = "{}"
		}
		scopes := strings.TrimSpace(req.Scopes)

		id := newProviderID()
		var createdBy interface{}
		if user != nil && user.ID != "" {
			createdBy = user.ID
		}
		_, err = db.Exec(
			`INSERT INTO oauth_providers (
				id, provider_id, name, type, enabled, position,
				client_id, client_secret, scopes,
				auth_endpoint, token_endpoint, userinfo_endpoint,
				issuer, extra_config, created_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, req.ProviderID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Type),
			enabled, position,
			strings.TrimSpace(req.ClientID), secret, scopes,
			strings.TrimSpace(req.AuthEndpoint), strings.TrimSpace(req.TokenEndpoint),
			strings.TrimSpace(req.UserinfoEndpoint),
			strings.TrimSpace(req.Issuer), extraConfig, createdBy,
		)
		if err != nil {
			if isUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": "providerId already exists"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Audit log (s-1147): record the create before returning
		// so a partial failure between INSERT and the JSON
		// response still leaves a trail.
		logOAuthAdminActivity(db, user.ID, AuditActionOAuthProviderCreate,
			id, req.ProviderID,
			OAuthAuditDetails{
				Changed:       []string{"provider_id", "name", "type", "enabled", "position", "client_id", "scopes", "auth_endpoint", "token_endpoint", "userinfo_endpoint", "issuer", "extra_config"},
				SecretChanged: strings.TrimSpace(req.ClientSecret) != "",
			},
			c.ClientIP(),
		)
		row, ferr := fetchProviderByID(db, id)
		if ferr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": ferr.Error()})
			return
		}
		c.JSON(http.StatusCreated, row)
	}
}

// GetAdminProviderHandler serves GET /api/v1/oauth/providers/:id.
func GetAdminProviderHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := requireAdmin(c, db); !ok {
			return
		}
		id := strings.TrimSpace(c.Param("id"))
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
			return
		}
		row, err := fetchProviderByID(db, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "provider not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, row)
	}
}

// UpdateAdminProviderHandler serves PUT /api/v1/oauth/providers/:id.
// Only the fields present in the request body are touched; absent
// fields keep their stored value.
func UpdateAdminProviderHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := requireAdmin(c, db)
		if !ok {
			return
		}
		id := strings.TrimSpace(c.Param("id"))
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
			return
		}
		var req UpdateProviderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
			return
		}

		existing, err := fetchProviderByID(db, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "provider not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		merged := providerFromAdmin(existing)
		changedFields := []string{}
		previousValues := map[string]string{}

		if req.Name != nil && *req.Name != existing.Name {
			changedFields = append(changedFields, "name")
			previousValues["name"] = existing.Name
			merged.Name = strings.TrimSpace(*req.Name)
		}
		if req.Name != nil {
			merged.Name = strings.TrimSpace(*req.Name)
		}
		if req.Type != nil && *req.Type != existing.Type {
			changedFields = append(changedFields, "type")
			previousValues["type"] = existing.Type
			merged.Type = strings.TrimSpace(*req.Type)
		}
		if req.Type != nil {
			merged.Type = strings.TrimSpace(*req.Type)
		}
		enabledChanged := false
		if req.Enabled != nil && *req.Enabled != existing.Enabled {
			enabledChanged = true
			// Note: we deliberately do NOT add "enabled" to
			// changedFields here. The boolean flip gets its
			// own dedicated audit row (OAUTH_PROVIDER_ENABLE /
			// OAUTH_PROVIDER_DISABLE) below, and a duplicate
			// entry in the UPDATE row would inflate the audit
			// log with redundant signals. The `previous` map
			// keeps the previous value reachable from the
			// dedicated enable/disable row's details payload
			// via EnabledBefore instead.
			merged.Enabled = *req.Enabled
		}
		if req.Enabled != nil {
			merged.Enabled = *req.Enabled
		}
		if req.Position != nil && *req.Position != existing.Position {
			changedFields = append(changedFields, "position")
			previousValues["position"] = strconv.Itoa(existing.Position)
			merged.Position = *req.Position
		}
		if req.Position != nil {
			merged.Position = *req.Position
		}
		if req.ClientID != nil && *req.ClientID != existing.ClientID {
			changedFields = append(changedFields, "client_id")
			previousValues["client_id"] = existing.ClientID
			merged.ClientID = strings.TrimSpace(*req.ClientID)
		}
		if req.ClientID != nil {
			merged.ClientID = strings.TrimSpace(*req.ClientID)
		}
		if req.Scopes != nil && *req.Scopes != existing.Scopes {
			changedFields = append(changedFields, "scopes")
			previousValues["scopes"] = existing.Scopes
			merged.Scopes = strings.TrimSpace(*req.Scopes)
		}
		if req.Scopes != nil {
			merged.Scopes = strings.TrimSpace(*req.Scopes)
		}
		if req.AuthEndpoint != nil && *req.AuthEndpoint != existing.AuthEndpoint {
			changedFields = append(changedFields, "auth_endpoint")
			previousValues["auth_endpoint"] = existing.AuthEndpoint
			merged.AuthEndpoint = strings.TrimSpace(*req.AuthEndpoint)
		}
		if req.AuthEndpoint != nil {
			merged.AuthEndpoint = strings.TrimSpace(*req.AuthEndpoint)
		}
		if req.TokenEndpoint != nil && *req.TokenEndpoint != existing.TokenEndpoint {
			changedFields = append(changedFields, "token_endpoint")
			previousValues["token_endpoint"] = existing.TokenEndpoint
			merged.TokenEndpoint = strings.TrimSpace(*req.TokenEndpoint)
		}
		if req.TokenEndpoint != nil {
			merged.TokenEndpoint = strings.TrimSpace(*req.TokenEndpoint)
		}
		if req.UserinfoEndpoint != nil && *req.UserinfoEndpoint != existing.UserinfoEndpoint {
			changedFields = append(changedFields, "userinfo_endpoint")
			previousValues["userinfo_endpoint"] = existing.UserinfoEndpoint
			merged.UserinfoEndpoint = strings.TrimSpace(*req.UserinfoEndpoint)
		}
		if req.UserinfoEndpoint != nil {
			merged.UserinfoEndpoint = strings.TrimSpace(*req.UserinfoEndpoint)
		}
		if req.Issuer != nil && *req.Issuer != existing.Issuer {
			changedFields = append(changedFields, "issuer")
			previousValues["issuer"] = existing.Issuer
			merged.Issuer = strings.TrimSpace(*req.Issuer)
		}
		if req.Issuer != nil {
			merged.Issuer = strings.TrimSpace(*req.Issuer)
		}
		if req.ExtraConfig != nil && *req.ExtraConfig != existing.ExtraConfig {
			changedFields = append(changedFields, "extra_config")
			previousValues["extra_config"] = existing.ExtraConfig
			merged.ExtraConfig = strings.TrimSpace(*req.ExtraConfig)
		}
		if req.ExtraConfig != nil {
			merged.ExtraConfig = strings.TrimSpace(*req.ExtraConfig)
		}
		secretChanged := req.ClientSecret != nil && strings.TrimSpace(*req.ClientSecret) != ""
		if secretChanged {
			changedFields = append(changedFields, "client_secret")
		}
		if err := ValidateProviderPayload(
			existing.ProviderID, merged.Name, merged.Type,
			merged.ClientID, merged.Scopes,
			merged.AuthEndpoint, merged.TokenEndpoint, merged.UserinfoEndpoint,
			merged.Issuer, merged.ExtraConfig,
		); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var secret interface{}
		if req.ClientSecret != nil {
			blob, err := EncryptProviderSecret([]byte(*req.ClientSecret))
			if err != nil {
				if errors.Is(err, ErrProviderSecretKeyMissing) {
					c.JSON(http.StatusServiceUnavailable, gin.H{
						"error": "OAUTH_PROVIDER_ENCRYPTION_KEY is not configured",
					})
					return
				}
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			secret = blob
		}

		enabledInt := 0
		if merged.Enabled {
			enabledInt = 1
		}
		extraConfig := merged.ExtraConfig
		if extraConfig == "" {
			extraConfig = "{}"
		}

		args := []interface{}{
			merged.Name, merged.Type, enabledInt, merged.Position,
			merged.ClientID, merged.Scopes,
			merged.AuthEndpoint, merged.TokenEndpoint, merged.UserinfoEndpoint,
			merged.Issuer, extraConfig,
		}
		query := `UPDATE oauth_providers
		         SET name = ?, type = ?, enabled = ?, position = ?,
		             client_id = ?, scopes = ?,
		             auth_endpoint = ?, token_endpoint = ?, userinfo_endpoint = ?,
		             issuer = ?, extra_config = ?`
		if req.ClientSecret != nil {
			query += `, client_secret = ?`
			args = append(args, secret)
		}
		query += `, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
		args = append(args, id)

		if _, err := db.Exec(query, args...); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Audit log (s-1147): when only the boolean enabled
		// flag flips, emit OAUTH_PROVIDER_ENABLE /
		// OAUTH_PROVIDER_DISABLE so the activity-log filter can
		// surface those transitions separately from a general
		// config edit. When other fields change as well, emit
		// OAUTH_PROVIDER_UPDATE first and then the enable /
		// disable event so each transition is its own row.
		if enabledChanged {
			enabledBefore := existing.Enabled
			enabledAfter := merged.Enabled
			action := AuditActionOAuthProviderEnable
			if !enabledAfter {
				action = AuditActionOAuthProviderDisable
			}
			logOAuthAdminActivity(db, user.ID, action,
				id, existing.ProviderID,
				OAuthAuditDetails{
					EnabledBefore: &enabledBefore,
					EnabledAfter:  &enabledAfter,
				},
				c.ClientIP(),
			)
		}
		if len(changedFields) > 0 {
			logOAuthAdminActivity(db, user.ID, AuditActionOAuthProviderUpdate,
				id, existing.ProviderID,
				OAuthAuditDetails{
					Changed:       changedFields,
					Previous:      previousValues,
					SecretChanged: secretChanged,
				},
				c.ClientIP(),
			)
		}

		row, ferr := fetchProviderByID(db, id)
		if ferr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": ferr.Error()})
			return
		}
		c.JSON(http.StatusOK, row)
	}
}

// DeleteAdminProviderHandler serves DELETE /api/v1/oauth/providers/:id.
// user_identities cascades via ON DELETE CASCADE so bound identities
// are removed atomically; an explicit ?force=1 query parameter is
// accepted but treated as a no-op for now (kept for forward
// compatibility with plan §6.1).
func DeleteAdminProviderHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := requireAdmin(c, db)
		if !ok {
			return
		}
		id := strings.TrimSpace(c.Param("id"))
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
			return
		}
		// Capture the provider_id before delete so the audit
		// row has a human-readable target_title. The detail
		// payload also carries the previous state so a forensic
		// reviewer can reconstruct what was removed.
		existing, ferr := fetchProviderByID(db, id)
		if ferr != nil && !errors.Is(ferr, sql.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": ferr.Error()})
			return
		}
		res, err := db.Exec(`DELETE FROM oauth_providers WHERE id = ?`, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "provider not found"})
			return
		}
		providerTitle := id
		if existing != nil {
			providerTitle = existing.ProviderID
		}
		// Audit log (s-1147).
		logOAuthAdminActivity(db, user.ID, AuditActionOAuthProviderDelete,
			id, providerTitle,
			OAuthAuditDetails{Existed: true},
			c.ClientIP(),
		)
		c.JSON(http.StatusOK, gin.H{"deleted": id})
	}
}

// fetchProviderByID loads a single provider by its internal id and
// returns the wire shape with the secret redacted.
func fetchProviderByID(db *sql.DB, id string) (*AdminOAuthProvider, error) {
	var (
		p        AdminOAuthProvider
		secret   sql.NullString
		createdB sql.NullString
	)
	err := db.QueryRow(
		`SELECT id, provider_id, name, type, enabled, position,
		        client_id, client_secret, scopes, auth_endpoint, token_endpoint,
		        userinfo_endpoint, issuer, extra_config,
		        created_at, updated_at, created_by
		 FROM oauth_providers WHERE id = ?`, id,
	).Scan(
		&p.ID, &p.ProviderID, &p.Name, &p.Type, &p.Enabled, &p.Position,
		&p.ClientID, &secret, &p.Scopes, &p.AuthEndpoint, &p.TokenEndpoint,
		&p.UserinfoEndpoint, &p.Issuer, &p.ExtraConfig,
		&p.CreatedAt, &p.UpdatedAt, &createdB,
	)
	if err != nil {
		return nil, err
	}
	p.SecretSet = secret.Valid && len(secret.String) > 0
	if createdB.Valid {
		p.CreatedBy = createdB.String
	}
	return &p, nil
}

// providerFromAdmin projects the wire shape into the merge-friendly
// scratch struct used by UpdateAdminProviderHandler so that absent
// fields keep their stored values.
type providerMerge struct {
	Name             string
	Type             string
	Enabled          bool
	Position         int
	ClientID         string
	Scopes           string
	AuthEndpoint     string
	TokenEndpoint    string
	UserinfoEndpoint string
	Issuer           string
	ExtraConfig      string
}

func providerFromAdmin(p *AdminOAuthProvider) providerMerge {
	return providerMerge{
		Name:             p.Name,
		Type:             p.Type,
		Enabled:          p.Enabled,
		Position:         p.Position,
		ClientID:         p.ClientID,
		Scopes:           p.Scopes,
		AuthEndpoint:     p.AuthEndpoint,
		TokenEndpoint:    p.TokenEndpoint,
		UserinfoEndpoint: p.UserinfoEndpoint,
		Issuer:           p.Issuer,
		ExtraConfig:      p.ExtraConfig,
	}
}

// isUniqueViolation recognises the unique-constraint error from
// SQLite and MySQL drivers without importing the driver packages —
// the error strings are stable and the only place we map to 409.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "Duplicate entry") ||
		strings.Contains(msg, "duplicate key")
}
