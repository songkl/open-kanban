package oauth

// Phase 5 stub: external identity provider integration.
//
// This package deliberately ships an empty placeholder so the OAuth 2.1
// surfaces (Discovery, JWKS, Device Flow, Token, Admin) remain the source
// of truth for the self-hosted kanban authorization server while leaving a
// well-defined seam for hooking in Google/GitHub/Keycloak/Auth0 later.
//
// Roadmap for the Phase 5 implementation:
//
//  1. Add a `user_identities` table (provider, subject, user_id).
//  2. Extend `app_config` with `oauth_external_provider`, `oauth_external_client_id`,
//     `oauth_external_client_secret`, `oauth_external_issuer`, `oauth_external_scopes`.
//  3. Implement a new `/oauth/external/authorize` route that proxies to the
//     IdP discovery doc and starts the IdP authorization code flow.
//  4. Implement `/oauth/external/callback` to exchange the IdP code for an
//     IdP id_token, map it to a local user (provisioning on first sight),
//     and mint a kanban access token (handled by issueAccessAndRefresh).
//  5. Gate the legacy /auth/login + /auth/init routes behind a "first-party
//     auth" toggle so self-hosted installs can disable username/password.
//
// No implementation work is included here because (a) it requires choosing
// one or more concrete IdPs and (b) it would balloon this PR. The seams
// above keep the upgrade path forward-compatible without touching the
// existing OAuth 2.1 self-hosted flow.

// ExternalProviderConfig captures the placeholder config surface. It is not
// wired to the DB yet; the keys exist in the canonical config registry so
// admin settings UIs can render them as disabled/coming-soon rows.
type ExternalProviderConfig struct {
	Provider     string // "google" | "github" | "oidc" | ""
	ClientID     string
	ClientSecret string
	Issuer       string // for generic OIDC
	Scopes       string // space-separated
	Enabled      bool
}

// IsExternalEnabled returns true only when all required fields are set and
// the config marks the feature as enabled. The canonical source of these
// values will move into the app_config table during the Phase 5 PR.
func (c ExternalProviderConfig) IsExternalEnabled() bool {
	if !c.Enabled {
		return false
	}
	if c.Provider == "" || c.ClientID == "" {
		return false
	}
	if c.Provider == "oidc" && c.Issuer == "" {
		return false
	}
	return true
}