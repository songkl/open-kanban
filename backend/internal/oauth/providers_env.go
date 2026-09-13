package oauth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// EnvProviderSeedKey is the canonical name of the JSON-array env var
// documented in docs/ENVIRONMENT.md and plan §6.3.
//
// Example value:
//
//	OAUTH_EXTERNAL_PROVIDERS='[{"providerId":"google","name":"Google",
//		"type":"google","clientId":"…","clientSecret":"…",
//		"scopes":"openid email profile","enabled":true}]'
//
// Field naming follows the admin API shape (providerId / clientId)
// so operators can copy a row from GET /api/v1/oauth/providers
// straight into their container config without renaming keys. The
// legacy plan §6.3 aliases (kind / slug / displayName) are also
// accepted so existing drafts keep working.
const EnvProviderSeedKey = "OAUTH_EXTERNAL_PROVIDERS"

// EnvProviderSeed is the JSON shape the seeder accepts. It mirrors
// CreateProviderRequest but is intentionally a separate type so
// future tightening of the API contract (e.g. requiring an `enabled`
// field) does not silently break env-var seeding.
type EnvProviderSeed struct {
	// ProviderID is the public slug. Required. Must match
	// providerIDRegex (same regex as the API surface).
	ProviderID string `json:"providerId"`

	// Aliases so deployments written against the original plan
	// draft (slug / kind / displayName) keep loading without
	// surgery. The canonical names always win when both are
	// supplied.
	Slug        string `json:"slug"`
	Kind        string `json:"kind"`
	DisplayName string `json:"displayName"`

	Name string `json:"name"`
	Type string `json:"type"`

	// Type alias so older drafts that use "kind" still work.
	KindAlias string `json:"-"`

	Enabled  *bool `json:"enabled"`
	Position *int  `json:"position"`

	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`

	Scopes           string `json:"scopes"`
	AuthEndpoint     string `json:"authEndpoint"`
	TokenEndpoint    string `json:"tokenEndpoint"`
	UserinfoEndpoint string `json:"userinfoEndpoint"`
	Issuer           string `json:"issuer"`
	ExtraConfig      string `json:"extraConfig"`
}

// SeedExternalProvidersFromEnv reads OAUTH_EXTERNAL_PROVIDERS, parses
// the JSON array, and inserts any provider whose slug is not already
// in the DB. Slugs that already exist are left untouched — UI edits
// always win, per plan §6.3 ("UI edits always win").
//
// Errors:
//   - Missing / empty env var: returns nil (nothing to seed). The
//     seeder is a no-op in the default deployment.
//   - Malformed JSON: returns an error so the operator notices. We
//     refuse to silently ignore bad config because a typo'd secret
//     would mean the operator thinks the provider is configured when
//     it is not.
//   - Per-row validation failure: the offending row is skipped with
//     an error attached to the returned slice. Other rows still
//     seed. The caller decides whether to log the partial failure
//     or hard-fail.
//
// Encryption: every client_secret is run through EncryptProviderSecret
// so the seeded row matches the shape the admin CRUD writes — the
// callback handler's DecryptProviderSecret read path is exercised on
// the same ciphertext format. Empty client_secret (public-client
// providers) is stored as NULL per the existing convention.
func SeedExternalProvidersFromEnv(db *sql.DB) error {
	return seedExternalProvidersFromEnv(db, os.Getenv(EnvProviderSeedKey))
}

// seedExternalProvidersFromEnv is the test seam. Production callers
// use SeedExternalProvidersFromEnv which reads the env var once;
// tests pass the JSON body in directly so they don't have to mutate
// os.Environ() per case.
func seedExternalProvidersFromEnv(db *sql.DB, raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	var seeds []EnvProviderSeed
	if err := json.Unmarshal([]byte(raw), &seeds); err != nil {
		return fmt.Errorf("oauth: %s is not valid JSON: %w", EnvProviderSeedKey, err)
	}

	var rowErrs []error
	for i := range seeds {
		seed := normaliseEnvProviderSeed(&seeds[i])
		if err := seedExternalProvider(db, &seed); err != nil {
			if errors.Is(err, errProviderAlreadyExists) {
				continue
			}
			rowErrs = append(rowErrs, fmt.Errorf("oauth: seed entry %d (%q): %w", i, seed.ProviderID, err))
		}
	}
	if len(rowErrs) > 0 {
		return errors.Join(rowErrs...)
	}
	return nil
}

// errProviderAlreadyExists signals the slug was already in the DB.
// It is filtered out of the aggregated error so UI wins silently.
var errProviderAlreadyExists = errors.New("oauth: provider already exists")

// seedExternalProvider inserts one row when the slug is free, or
// returns errProviderAlreadyExists otherwise. Validation is shared
// with the admin CRUD handlers via ValidateProviderPayload so a
// field banned by the admin UI cannot sneak in via the env var.
func seedExternalProvider(db *sql.DB, seed *EnvProviderSeed) error {
	if err := ValidateProviderPayload(
		seed.ProviderID, seed.Name, seed.Type,
		seed.ClientID, seed.Scopes,
		seed.AuthEndpoint, seed.TokenEndpoint, seed.UserinfoEndpoint,
		seed.Issuer, seed.ExtraConfig,
	); err != nil {
		return err
	}

	var existing string
	err := db.QueryRow(
		`SELECT id FROM oauth_providers WHERE provider_id = ?`, seed.ProviderID,
	).Scan(&existing)
	if err == nil {
		return errProviderAlreadyExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("oauth: lookup existing provider: %w", err)
	}

	secret, err := EncryptProviderSecret([]byte(seed.ClientSecret))
	if err != nil {
		return fmt.Errorf("oauth: encrypt client_secret: %w", err)
	}

	enabled := 1
	if seed.Enabled != nil && !*seed.Enabled {
		enabled = 0
	}
	position := 0
	if seed.Position != nil {
		position = *seed.Position
	}
	extraConfig := strings.TrimSpace(seed.ExtraConfig)
	if extraConfig == "" {
		extraConfig = "{}"
	}
	scopes := strings.TrimSpace(seed.Scopes)

	id := newProviderID()
	if _, err := db.Exec(
		`INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_by
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		id, seed.ProviderID, seed.Name, seed.Type,
		enabled, position,
		seed.ClientID, secret, scopes,
		seed.AuthEndpoint, seed.TokenEndpoint, seed.UserinfoEndpoint,
		seed.Issuer, extraConfig,
	); err != nil {
		if isUniqueViolation(err) {
			return errProviderAlreadyExists
		}
		return fmt.Errorf("oauth: insert provider: %w", err)
	}
	return nil
}

// normaliseEnvProviderSeed collapses the legacy aliases (slug / kind /
// displayName) into the canonical fields and trims whitespace so
// operators can paste a sloppy JSON without the seed silently
// failing on whitespace drift.
func normaliseEnvProviderSeed(seed *EnvProviderSeed) EnvProviderSeed {
	out := *seed
	out.ProviderID = firstNonEmpty(strings.TrimSpace(out.ProviderID), strings.TrimSpace(out.Slug))
	out.Name = firstNonEmpty(strings.TrimSpace(out.Name), strings.TrimSpace(out.DisplayName))
	out.Type = firstNonEmpty(strings.TrimSpace(out.Type), strings.TrimSpace(out.Kind))
	out.ClientID = strings.TrimSpace(out.ClientID)
	out.Scopes = strings.TrimSpace(out.Scopes)
	out.AuthEndpoint = strings.TrimSpace(out.AuthEndpoint)
	out.TokenEndpoint = strings.TrimSpace(out.TokenEndpoint)
	out.UserinfoEndpoint = strings.TrimSpace(out.UserinfoEndpoint)
	out.Issuer = strings.TrimSpace(out.Issuer)
	out.ExtraConfig = strings.TrimSpace(out.ExtraConfig)
	return out
}

// firstNonEmpty returns the first argument that, after trimming,
// contains at least one rune. Used by normaliseEnvProviderSeed so
// the canonical field always wins when both forms are supplied.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}