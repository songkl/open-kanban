package oauth_test

import (
	"bytes"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	"open-kanban/internal/oauth"
)

// withEnvProviderSeed sets OAUTH_EXTERNAL_PROVIDERS for the duration
// of a test and restores the original value on cleanup. Mirrors
// withProviderSecretKey so the seeder suite stays symmetric with the
// crypto suite above.
func withEnvProviderSeed(t *testing.T, raw string) {
	t.Helper()
	prev, had := os.LookupEnv(oauth.EnvProviderSeedKey)
	if err := os.Setenv(oauth.EnvProviderSeedKey, raw); err != nil {
		t.Fatalf("set env: %v", err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(oauth.EnvProviderSeedKey, prev)
		} else {
			_ = os.Unsetenv(oauth.EnvProviderSeedKey)
		}
	})
}

// 1. Empty / unset env var is a no-op so the seeder does not
// interfere with installations that rely solely on the admin UI.
func TestSeedExternalProvidersFromEnv_EmptyIsNoop(t *testing.T) {
	withEnvProviderSeed(t, "")
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed empty: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM oauth_providers`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("expected no rows, got %d", n)
	}
}

// 2. Happy path: a single well-formed provider is inserted, its
// client_secret is encrypted (ciphertext stored, plaintext absent),
// and the row matches the admin-API shape.
func TestSeedExternalProvidersFromEnv_HappyPath(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "google-client-id",
		"clientSecret": "shhh-from-env",
		"scopes": "openid email profile"
	}]`)
	db := setupProviderDB(t)
	defer db.Close()

	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}

	row := fetchSeededProvider(t, db, "google")
	if row.Name != "Google" {
		t.Errorf("name mismatch: %q", row.Name)
	}
	if row.Type != "google" {
		t.Errorf("type mismatch: %q", row.Type)
	}
	if row.Enabled != 1 {
		t.Errorf("enabled mismatch: %d", row.Enabled)
	}
	if row.ClientID != "google-client-id" {
		t.Errorf("clientId mismatch: %q", row.ClientID)
	}
	if len(row.SecretBlob) <= 12 {
		t.Errorf("ciphertext too short: %d bytes", len(row.SecretBlob))
	}
	if bytes.Contains(row.SecretBlob, []byte("shhh-from-env")) {
		t.Errorf("plaintext leaked into the BLOB column")
	}
	plain, err := oauth.DecryptProviderSecret(row.SecretBlob)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != "shhh-from-env" {
		t.Errorf("round-trip mismatch: want %q, got %q", "shhh-from-env", plain)
	}
}

// 3. Seeding is idempotent on its own output: running it twice does
// not duplicate rows. Pins plan §6.3 ("only if the slug does not yet
// exist").
func TestSeedExternalProvidersFromEnv_Idempotent(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[{
		"providerId": "github",
		"name": "GitHub",
		"type": "github",
		"clientId": "gh",
		"clientSecret": "shh"
	}]`)
	db := setupProviderDB(t)
	defer db.Close()
	for i := 0; i < 3; i++ {
		if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
			t.Fatalf("seed pass %d: %v", i, err)
		}
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM oauth_providers`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("expected exactly 1 row, got %d", n)
	}
}

// 4. UI edits win: a row that already exists (seeded by the admin
// API) is left untouched even when the env var carries a newer
// config. Pins plan §6.3 ("UI edits always win").
func TestSeedExternalProvidersFromEnv_ExistingRowIsPreserved(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()

	// Simulate an admin-API write that happened earlier.
	existing := []byte("encrypted-by-ui")
	insertProvider(t, db, "google-row", "google", "Renamed via UI", 5, "ui-client", existing)

	withEnvProviderSeed(t, `[{
		"providerId": "google",
		"name": "Google (from env)",
		"type": "google",
		"clientId": "env-client",
		"clientSecret": "env-secret"
	}]`)
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}

	row := fetchSeededProvider(t, db, "google")
	if row.Name != "Renamed via UI" {
		t.Errorf("UI edit overwritten: got name=%q", row.Name)
	}
	if row.ClientID != "ui-client" {
		t.Errorf("UI clientId overwritten: got %q", row.ClientID)
	}
	if !bytes.Equal(row.SecretBlob, existing) {
		t.Errorf("UI ciphertext overwritten")
	}
	if row.Position != 5 {
		t.Errorf("UI position overwritten: got %d", row.Position)
	}
}

// 5. The seeder seeds multiple providers in a single call and each
// is encrypted independently.
func TestSeedExternalProvidersFromEnv_MultipleProviders(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[
		{"providerId": "google", "name": "Google", "type": "google",
		 "clientId": "g", "clientSecret": "g-secret"},
		{"providerId": "github", "name": "GitHub", "type": "github",
		 "clientId": "gh", "clientSecret": "gh-secret"}
	]`)
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for _, slug := range []string{"google", "github"} {
		row := fetchSeededProvider(t, db, slug)
		if row.ID == "" {
			t.Errorf("provider %q missing", slug)
			continue
		}
		plain, err := oauth.DecryptProviderSecret(row.SecretBlob)
		if err != nil {
			t.Errorf("%s decrypt: %v", slug, err)
			continue
		}
		if !strings.HasSuffix(plain, "-secret") {
			t.Errorf("%s plaintext mismatch: %q", slug, plain)
		}
	}
}

// 6. Malformed JSON is rejected with an error so a typo in the
// container config surfaces at startup rather than silently skipping
// every provider.
func TestSeedExternalProvidersFromEnv_InvalidJSONFails(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `{not json`)
	db := setupProviderDB(t)
	defer db.Close()
	err := oauth.SeedExternalProvidersFromEnv(db)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !strings.Contains(err.Error(), oauth.EnvProviderSeedKey) {
		t.Errorf("expected error to mention %s, got %v", oauth.EnvProviderSeedKey, err)
	}
}

// 7. A row that fails validation is skipped while the others still
// seed. The returned error aggregates the failures so the operator
// can see every problem in one boot log.
func TestSeedExternalProvidersFromEnv_PartialFailure(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[
		{"providerId": "google", "name": "Google", "type": "google",
		 "clientId": "g", "clientSecret": "ok"},
		{"providerId": "BAD SLUG", "name": "X", "type": "google",
		 "clientId": "x", "clientSecret": "y"}
	]`)
	db := setupProviderDB(t)
	defer db.Close()
	err := oauth.SeedExternalProvidersFromEnv(db)
	if err == nil {
		t.Fatal("expected aggregated error")
	}
	// The good row must still be in the DB.
	row := fetchSeededProvider(t, db, "google")
	if row.ID == "" {
		t.Error("good row was not seeded despite partial failure")
	}
	if !strings.Contains(err.Error(), "BAD SLUG") && !strings.Contains(err.Error(), "providerId") {
		t.Errorf("expected error to mention bad slug, got %v", err)
	}
}

// 8. The seeder honours the legacy aliases (slug / kind /
// displayName) so deployments written against the original plan
// draft keep loading.
func TestSeedExternalProvidersFromEnv_LegacyAliases(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[{
		"slug": "google",
		"kind": "google",
		"displayName": "Google",
		"clientId": "g",
		"clientSecret": "shh"
	}]`)
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}
	row := fetchSeededProvider(t, db, "google")
	if row.Name != "Google" {
		t.Errorf("displayName alias not honoured: %q", row.Name)
	}
}

// 9. Empty client_secret produces a NULL column (public-client
// convention) so the callback handler treats the row as a PKCE-only
// provider.
func TestSeedExternalProvidersFromEnv_PublicClientHasNullSecret(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[{
		"providerId": "public",
		"name": "Public",
		"type": "github",
		"clientId": "g"
	}]`)
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}
	row := fetchSeededProvider(t, db, "public")
	if len(row.SecretBlob) != 0 {
		t.Errorf("expected NULL secret blob, got %d bytes", len(row.SecretBlob))
	}
	if row.SecretSet {
		t.Error("expected secretSet=false for public client")
	}
}

// 10. Without the encryption key the seeder fails fast with the same
// ErrProviderSecretKeyMissing the admin API surfaces, so the
// operator notices the misconfiguration on first boot.
func TestSeedExternalProvidersFromEnv_MissingKeyFails(t *testing.T) {
	withProviderSecretKey(t, "")
	withEnvProviderSeed(t, `[{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "g",
		"clientSecret": "shh"
	}]`)
	db := setupProviderDB(t)
	defer db.Close()
	err := oauth.SeedExternalProvidersFromEnv(db)
	if err == nil {
		t.Fatal("expected error when encryption key missing")
	}
	if !errors.Is(err, oauth.ErrProviderSecretKeyMissing) &&
		!strings.Contains(err.Error(), "OAUTH_PROVIDER_ENCRYPTION_KEY") {
		t.Errorf("expected missing-key error, got %v", err)
	}
}

// 11. enabled=false in the env var produces an enabled=0 row so an
// operator can stage providers in a "do not serve yet" state.
func TestSeedExternalProvidersFromEnv_Disabled(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"clientId": "g",
		"clientSecret": "shh",
		"enabled": false
	}]`)
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}
	row := fetchSeededProvider(t, db, "google")
	if row.Enabled != 0 {
		t.Errorf("expected enabled=0, got %d", row.Enabled)
	}
}

// 12. position is honoured so an operator can pin a preferred
// ordering (Google first, GitHub second).
func TestSeedExternalProvidersFromEnv_PositionHonoured(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	withEnvProviderSeed(t, `[
		{"providerId": "google", "name": "Google", "type": "google",
		 "clientId": "g", "clientSecret": "x", "position": 0},
		{"providerId": "github", "name": "GitHub", "type": "github",
		 "clientId": "h", "clientSecret": "y", "position": 1}
	]`)
	db := setupProviderDB(t)
	defer db.Close()
	if err := oauth.SeedExternalProvidersFromEnv(db); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if r := fetchSeededProvider(t, db, "google"); r.Position != 0 {
		t.Errorf("google position=%d", r.Position)
	}
	if r := fetchSeededProvider(t, db, "github"); r.Position != 1 {
		t.Errorf("github position=%d", r.Position)
	}
}

// seededProviderRow is the projection tests use to assert against.
// Keeping the type local to the test file means production code
// never grows a half-used wire shape just for assertions.
type seededProviderRow struct {
	ID         string
	ProviderID string
	Name       string
	Type       string
	Enabled    int
	Position   int
	ClientID   string
	SecretBlob []byte
	SecretSet  bool
}

// fetchSeededProvider loads one row by provider_id so each test
// stays self-contained. Mirrors fetchProviderByID inside the oauth
// package but returns the columns most relevant for seeding
// assertions (no timestamps, no created_by).
func fetchSeededProvider(t *testing.T, db *sql.DB, slug string) seededProviderRow {
	t.Helper()
	var row seededProviderRow
	err := db.QueryRow(
		`SELECT id, provider_id, name, type, enabled, position,
		        client_id, client_secret
		 FROM oauth_providers WHERE provider_id = ?`, slug,
	).Scan(
		&row.ID, &row.ProviderID, &row.Name, &row.Type, &row.Enabled, &row.Position,
		&row.ClientID, &row.SecretBlob,
	)
	if err != nil {
		return row
	}
	row.SecretSet = len(row.SecretBlob) > 0
	return row
}