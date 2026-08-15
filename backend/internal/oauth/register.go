package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"open-kanban/internal/models"
)

// RegistrationRequest mirrors RFC 7591 §2 with a few extra fields.
type RegistrationRequest struct {
	RedirectURIs            []string `json:"redirect_uris,omitempty"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	ResponseTypes           []string `json:"response_types,omitempty"`
	ClientName              string   `json:"client_name,omitempty"`
	ClientURI               string   `json:"client_uri,omitempty"`
	LogoURI                 string   `json:"logo_uri,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
	Contacts                []string `json:"contacts,omitempty"`
	SoftwareStatement       string   `json:"software_statement,omitempty"`
}

// AllowedAuthMethods lists auth methods that can be selected during DCR.
var AllowedAuthMethods = map[string]struct{}{
	"none":                {},
	"client_secret_basic": {},
	"client_secret_post":  {},
}

// DCRMaxNameLength caps the client_name length to avoid abuse.
const DCRMaxNameLength = 100

// RegisterClient handles POST /oauth/register per RFC 7591. Public clients
// (token_endpoint_auth_method == "none") only receive a client_id, while
// confidential clients also receive a client_secret which is shown only once
// (the AS stores only the bcrypt hash).
//
// When dynamic registration is disabled in app_config (`oauth_allow_dynamic_client_registration=0`),
// the endpoint returns 403.
func RegisterClient(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !DynamicRegistrationEnabled(db) {
			c.JSON(http.StatusForbidden, models.OAuthErrorResponse{
				Error:            "access_denied",
				ErrorDescription: "dynamic client registration is disabled",
			})
			return
		}

		var req RegistrationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: "request body is not valid JSON",
			})
			return
		}

		method := req.TokenEndpointAuthMethod
		if method == "" {
			method = "none"
		}
		if _, ok := AllowedAuthMethods[method]; !ok {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_client_metadata",
				ErrorDescription: fmt.Sprintf("unsupported token_endpoint_auth_method: %s", method),
			})
			return
		}

		if req.ClientName == "" {
			req.ClientName = "Unnamed Client"
		}
		if len(req.ClientName) > DCRMaxNameLength {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_client_metadata",
				ErrorDescription: "client_name too long",
			})
			return
		}

		// Validate grant_types against supported set.
		grantTypes := req.GrantTypes
		if len(grantTypes) == 0 {
			grantTypes = []string{GrantTypeDeviceCode, GrantTypeRefresh}
		}
		for _, gt := range grantTypes {
			if !containsString(SupportedGrantTypes, gt) {
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_client_metadata",
					ErrorDescription: fmt.Sprintf("unsupported grant_type: %s", gt),
				})
				return
			}
		}

		// Validate scope if provided.
		scope := strings.TrimSpace(req.Scope)
		if scope != "" {
			tokens := strings.Fields(scope)
			if !IsScopeAllowed(tokens, SupportedScopes()) {
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_scope",
					ErrorDescription: "requested scope contains unsupported values",
				})
				return
			}
		}

		// Validate redirect URIs: only loopback http allowed for public clients.
		redirectURIs := dedupNonEmpty(req.RedirectURIs)
		for _, u := range redirectURIs {
			if !isValidRedirectURI(u, method) {
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_redirect_uri",
					ErrorDescription: fmt.Sprintf("redirect_uri %q is not allowed", u),
				})
				return
			}
		}
		if method != "none" && len(redirectURIs) == 0 {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_redirect_uri",
				ErrorDescription: "confidential clients must register at least one redirect_uri",
			})
			return
		}

		clientID, err := randomClientID()
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error:            "server_error",
				ErrorDescription: "failed to generate client_id",
			})
			return
		}

		clientSecret := ""
		var secretHash *string
		if method != "none" {
			plain, hash, err := generateClientSecret()
			if err != nil {
				c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
					Error:            "server_error",
					ErrorDescription: "failed to generate client_secret",
				})
				return
			}
			clientSecret = plain
			secretHash = &hash
		}

		rowID := generateOpaqueID()
		redirectJSON, _ := json.Marshal(redirectURIs)
		grantJSON, _ := json.Marshal(grantTypes)
		// Store scopes as canonical space-separated string for easy matching.
		scopesAllowed := scope
		if scopesAllowed == "" {
			scopesAllowed = strings.Join(SupportedScopes(), " ")
		}
		scopeList := strings.Fields(scopesAllowed)
		scopeJSON, _ := json.Marshal(scopeList)

		_, err = db.Exec(
			`INSERT INTO oauth_clients
				(id, client_id, client_secret_hash, name, redirect_uris, grant_types,
				 token_endpoint_auth_method, scopes, is_first_party, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			rowID, clientID, secretHash, req.ClientName,
			string(redirectJSON), string(grantJSON),
			method, string(scopeJSON), time.Now(), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error:            "server_error",
				ErrorDescription: err.Error(),
			})
			return
		}

		c.Header("Cache-Control", "no-store")
		c.Header("Pragma", "no-cache")
		c.JSON(http.StatusCreated, models.OAuthClientRegistrationResponse{
			ClientID:                clientID,
			ClientSecret:            clientSecret,
			ClientIDIssuedAt:        time.Now().Unix(),
			RedirectURIs:            redirectURIs,
			GrantTypes:              grantTypes,
			TokenEndpointAuthMethod: method,
			Scope:                   scopesAllowed,
			ClientName:              req.ClientName,
		})
	}
}

// GetClient returns the persisted OAuthClient for a given client_id.
func GetClient(db *sql.DB, clientID string) (*models.OAuthClient, error) {
	row := db.QueryRow(
		`SELECT id, client_id, client_secret_hash, name, redirect_uris, grant_types,
		         token_endpoint_auth_method, scopes, is_first_party, created_at, updated_at
		 FROM oauth_clients WHERE client_id = ?`,
		clientID,
	)
	var (
		c            models.OAuthClient
		redirectJSON string
		grantJSON    string
		scopeJSON    string
	)
	err := row.Scan(&c.ID, &c.ClientID, &c.ClientSecretHash, &c.Name, &redirectJSON,
		&grantJSON, &c.TokenEndpointAuthMethod, &scopeJSON, &c.IsFirstParty,
		&c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(redirectJSON), &c.RedirectURIs)
	_ = json.Unmarshal([]byte(grantJSON), &c.GrantTypes)
	_ = json.Unmarshal([]byte(scopeJSON), &c.Scopes)
	return &c, nil
}

// ClientAllowsGrant returns true if the registered client has the given grant in its allow list.
func ClientAllowsGrant(c *models.OAuthClient, grant string) bool {
	return containsString(c.GrantTypes, grant)
}

// ClientAllowsScope returns true if the requested scope is within the registered scopes.
func ClientAllowsScope(c *models.OAuthClient, requested string) bool {
	if len(c.Scopes) == 0 {
		return true
	}
	registered := ParseScopes(strings.Join(c.Scopes, " "))
	requestedSet := ParseScopes(requested)
	return requestedSet.IsSubsetOf(registered)
}

// VerifyClientSecret returns nil when plain matches the stored bcrypt hash, or
// sql.ErrNoRows when the client is public.
func VerifyClientSecret(c *models.OAuthClient, plain string) error {
	if c.ClientSecretHash == nil {
		return errors.New("oauth: client has no secret configured")
	}
	return bcrypt.CompareHashAndPassword([]byte(*c.ClientSecretHash), []byte(plain))
}

// DynamicRegistrationEnabled returns true unless explicitly disabled.
func DynamicRegistrationEnabled(db *sql.DB) bool {
	var val string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'oauth_allow_dynamic_client_registration'").Scan(&val); err != nil {
		return true
	}
	return val != "0"
}

func randomClientID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "kanban-client-" + hex.EncodeToString(buf), nil
}

func generateClientSecret() (string, string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	plain := base64.RawURLEncoding.EncodeToString(buf)
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", "", err
	}
	return plain, string(hash), nil
}

// generateOpaqueID is a short random hex used as the row primary key.
func generateOpaqueID() string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func isValidRedirectURI(u string, authMethod string) bool {
	if u == "" {
		return false
	}
	lower := strings.ToLower(u)
	if strings.HasPrefix(lower, "https://") {
		return true
	}
	if strings.HasPrefix(lower, "http://127.0.0.1") || strings.HasPrefix(lower, "http://localhost") {
		return true
	}
	if strings.HasPrefix(lower, "urn:ietf:wg:org:oauth:oauth2.0:oob") {
		return true
	}
	if authMethod == "none" && (strings.HasPrefix(lower, "http://127.0.0.1") || strings.HasPrefix(lower, "http://localhost")) {
		return true
	}
	// Custom kanban scheme for native apps.
	if strings.HasPrefix(lower, "kanban://") {
		return true
	}
	return false
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func dedupNonEmpty(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// HashToken returns a hex SHA-256 of the input suitable for storing refresh
// token and device code hashes.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// LookupClientSecret is a helper for tests: returns the stored hash for the
// client_id or sql.ErrNoRows.
func LookupClientSecret(db *sql.DB, clientID string) (string, error) {
	var hash sql.NullString
	if err := db.QueryRow("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?", clientID).Scan(&hash); err != nil {
		return "", err
	}
	if !hash.Valid {
		return "", nil
	}
	return hash.String, nil
}