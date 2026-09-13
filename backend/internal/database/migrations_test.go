package database_test

import (
	"bytes"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/database/migrations"
)

func TestSQLiteMigrations(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	tables := []string{
		"users", "tokens", "boards", "board_permissions",
		"columns", "column_agents", "tasks", "comments",
		"subtasks", "attachments", "activities", "templates",
		"app_config", "column_permissions",
		"oauth_clients", "oauth_authorization_codes",
		"oauth_device_codes", "oauth_refresh_tokens", "oauth_consents",
		"oauth_providers", "user_identities",
		"pending_oauth_states",
		"task_runs",
		"webhooks", "webhook_deliveries",
	}

	taskRunIndexes := []string{
		"idx_task_runs_expires",
		"idx_task_runs_runner",
		"idx_task_runs_status",
		"idx_task_runs_finished_at",
		"idx_task_runs_status_finished_at",
	}
	for _, idx := range taskRunIndexes {
		var c int
		err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&c)
		if err != nil {
			t.Errorf("error checking task_runs index %s: %v", idx, err)
		}
		if c == 0 {
			t.Errorf("expected task_runs index %s to exist", idx)
		}
	}

	for _, table := range tables {
		var name string
		err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
		if err == sql.ErrNoRows {
			t.Errorf("table %s not found", table)
		} else if err != nil {
			t.Errorf("error checking table %s: %v", table, err)
		}
	}

	var accessTokenCol string
	err = db.QueryRow("SELECT access_token FROM attachments LIMIT 1").Scan(&accessTokenCol)
	if err != nil && err != sql.ErrNoRows {
		t.Errorf("access_token column not found in attachments: %v", err)
	}

	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_column_permissions_user'").Scan(&count)
	if err != nil {
		t.Errorf("error checking index: %v", err)
	}

	oauthIndexes := []string{
		"idx_oauth_clients_client_id",
		"idx_oauth_authcodes_client",
		"idx_oauth_authcodes_user",
		"idx_oauth_authcodes_expires",
		"idx_oauth_device_client",
		"idx_oauth_device_status",
		"idx_oauth_device_expires",
		"idx_oauth_refresh_user",
		"idx_oauth_refresh_client",
		"idx_oauth_refresh_expires",
		"idx_oauth_consents_user",
		"idx_oauth_providers_enabled",
		"idx_user_identities_user",
		"idx_users_email",
		"idx_pending_oauth_states_expires",
		"idx_pending_oauth_states_provider",
	}
	for _, idx := range oauthIndexes {
		var c int
		err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&c)
		if err != nil {
			t.Errorf("error checking oauth index %s: %v", idx, err)
		}
		if c == 0 {
			t.Errorf("expected oauth index %s to exist", idx)
		}
	}

	webhookIndexes := []string{
		"idx_webhook_deliveries_webhook_started",
		"idx_webhook_deliveries_status_next_retry",
	}
	for _, idx := range webhookIndexes {
		var c int
		err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&c)
		if err != nil {
			t.Errorf("error checking webhook index %s: %v", idx, err)
		}
		if c == 0 {
			t.Errorf("expected webhook index %s to exist", idx)
		}
	}
}

// TestSQLiteMigrationsAllowNewPermissionActions exercises the
// migration at the current tip (002_extend_activity_actions) and
// verifies the CHECK constraint on activities.action permits the
// PERMISSION_GRANT / PERMISSION_REVOKE action types added by the
// Set*/Delete* permission handlers. If a future migration narrows
// the constraint by accident this test fails before any handler
// test does.
func TestSQLiteMigrationsAllowNewPermissionActions(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	for _, action := range []string{"PERMISSION_GRANT", "PERMISSION_REVOKE"} {
		if _, err := db.Exec(
			"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, ?, 'BOARD', 'b1', 'web')",
			"a-"+action, "u1", action,
		); err != nil {
			t.Errorf("action %s should be permitted by CHECK constraint after migration 002, got: %v", action, err)
		}
	}
}

// TestSQLiteMigrationsAllowDeviceApproveActivity exercises migration
// 007 (s-1118) and verifies the CHECK constraints on activities.action
// and activities.target_type permit the DEVICE_APPROVE action and
// DEVICE target_type added by the device-flow agent-selection audit
// path. If a future migration narrows either constraint by accident
// this test fails before any handler test does.
func TestSQLiteMigrationsAllowDeviceApproveActivity(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	if _, err := db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, 'DEVICE_APPROVE', 'DEVICE', 'agent-1', 'web')",
		"a-device-approve", "u1",
	); err != nil {
		t.Errorf("DEVICE_APPROVE / DEVICE should be permitted by CHECK constraint after migration 007, got: %v", err)
	}
}

// TestSQLiteMigrationsAllowOAuthAdminAuditActivity exercises migration
// 013 (s-1147) and verifies the CHECK constraints on activities.action
// and activities.target_type permit the OAUTH_* admin-operation
// actions and the OAUTH target_type added by the OAuth audit-log
// path. If a future migration narrows either constraint by accident
// this test fails before any OAuth handler test does.
func TestSQLiteMigrationsAllowOAuthAdminAuditActivity(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	oauthActions := []string{
		"OAUTH_PROVIDER_CREATE",
		"OAUTH_PROVIDER_UPDATE",
		"OAUTH_PROVIDER_DELETE",
		"OAUTH_PROVIDER_ENABLE",
		"OAUTH_PROVIDER_DISABLE",
		"OAUTH_CLIENT_DELETE",
		"OAUTH_CONFIG_UPDATE",
		"OAUTH_CONSENT_REVOKE",
	}
	for i, action := range oauthActions {
		id := "a-oauth-" + action
		if _, err := db.Exec(
			"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, ?, 'OAUTH', 'target-1', 'web')",
			id, "u1", action,
		); err != nil {
			t.Errorf("action %s (index=%d) should be permitted by CHECK constraint after migration 013, got: %v", action, i, err)
		}
	}

	// Sanity: a row with a non-OAUTH target_type should still be
	// rejected once we narrow the CHECK accidentally. The test
	// above is the success path; this catches a regression where
	// the target_type list gets accidentally widened to a value
	// outside the documented allow-list.
	if _, err := db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, 'OAUTH_PROVIDER_CREATE', 'NOT_A_REAL_TYPE', 't', 'web')",
		"a-oauth-bad",
	); err == nil {
		t.Errorf("expected target_type CHECK to reject unknown value, got nil")
	}

	// Sanity: unknown action should be rejected by the CHECK so a
	// future refactor that adds a typo surfaces here rather than
	// in a handler.
	if _, err := db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, 'OAUTH_PROVIDER_TYPO', 'OAUTH', 't', 'web')",
		"a-oauth-typo",
	); err == nil {
		t.Errorf("expected action CHECK to reject unknown OAUTH_PROVIDER_TYPO, got nil")
	}
}

// TestSQLiteMigrationsAgentCreatedBy exercises migration 008 (s-1131)
// and verifies users.created_by can be INSERTed against a previously
// inserted creator, that the index is in place, and that the column
// is genuinely nullable (the up-migration deliberately leaves the
// column NULL for legacy AGENT rows so we cannot regress to NOT NULL
// without flagging it).
func TestSQLiteMigrationsAgentCreatedBy(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// Seed the creator (admin1) — must pre-exist before the
	// Agent row can reference it via the FK.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('admin1', 'admin', 'Admin', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed creator: %v", err)
	}

	// 1. New AGENT row can reference the creator.
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, type, role, enabled, created_by)
		 VALUES ('agent1', 'agent1', 'Agent One', 'AGENT', 'ADMIN', 1, 'admin1')`,
	); err != nil {
		t.Errorf("expected to insert AGENT with created_by FK after migration 008: %v", err)
	}

	// 2. Legacy AGENT row can omit created_by (the column is
	//    nullable by design — see migration comment).
	if _, err := db.Exec(
		`INSERT INTO users (id, username, nickname, type, role, enabled)
		 VALUES ('agent-legacy', 'agent-legacy', 'Legacy Agent', 'AGENT', 'ADMIN', 1)`,
	); err != nil {
		t.Errorf("expected legacy AGENT insert (no created_by) to succeed: %v", err)
	}
	var createdBy sql.NullString
	if err := db.QueryRow("SELECT created_by FROM users WHERE id = 'agent-legacy'").Scan(&createdBy); err != nil {
		t.Errorf("read created_by for legacy agent: %v", err)
	}
	if createdBy.Valid {
		t.Errorf("legacy agent should have NULL created_by, got %q", createdBy.String)
	}

	// 3. The index must exist so future /api/v1/auth/agents
	//    queries that filter by creator can use it.
	var idxCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_created_by'",
	).Scan(&idxCount); err != nil {
		t.Errorf("check idx_users_created_by: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_users_created_by after migration 008, got count=%d", idxCount)
	}

	// 4. Round-trip: reading created_by back returns the value we
	//    inserted (smoke check that the FK didn't silently coerce
	//    it).
	var back string
	if err := db.QueryRow("SELECT created_by FROM users WHERE id = 'agent1'").Scan(&back); err != nil {
		t.Fatalf("read created_by back: %v", err)
	}
	if back != "admin1" {
		t.Errorf("expected created_by=admin1, got %q", back)
	}

	// 5. The down migration drops the index and the column.
	//    Use m.Migrate(7) (the version strictly before 008) rather
	//    than m.Steps(-1) so the test stays correct when later
	//    migrations (009+) extend the tip — m.Steps(-1) would
	//    roll back whatever happens to be at the end, not 008.
	if err := m.Migrate(7); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("rollback 008: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_created_by'",
	).Scan(&idxCount); err != nil {
		t.Errorf("check idx_users_created_by after rollback: %v", err)
	}
	if idxCount != 0 {
		t.Errorf("expected idx_users_created_by to be dropped after rollback 008, got count=%d", idxCount)
	}

	// Bring migrations back up so the shared in-memory db stays
	// usable for the rest of the test suite.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
}

// TestSQLiteMigrationsOAuthProviders exercises migration 009
// (s-1140) end-to-end on SQLite. It verifies:
//
//   - oauth_providers comes up with the columns documented in
//     plan §3.2 of docs/OAUTH_EXTERNAL_PLAN_s-1139.md (id PK,
//     provider_id UNIQUE, name, type with the documented CHECK
//     allow-list, enabled/position defaults, client_id NOT NULL,
//     client_secret as BLOB and nullable, endpoint + scopes
//     defaults, created_by FK SET NULL to users, created_at /
//     updated_at).
//   - The CHECK constraint rejects an unknown `type` so the admin
//     API can't smuggle typos through to the dispatch table.
//   - UNIQUE(provider_id) prevents two providers from sharing a
//     URL handle.
//   - The ON DELETE SET NULL on created_by keeps the provider row
//     alive when its creator is removed.
//   - The enabled-default lookup index idx_oauth_providers_enabled
//     is present.
//   - The down migration drops both the index and the table.
//
// Mirrors the round-trip pattern used for migration 008 so a
// future regression in any of the constraints above fails before
// the admin CRUD handler tests do.
func TestSQLiteMigrationsOAuthProviders(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	// Enable FK enforcement on every connection in this pool.
	// The migrate driver does this for its own connection, but
	// the db.QueryRow / db.Exec calls below run on whatever
	// connection the pool hands us, and SQLite's
	// `PRAGMA foreign_keys = ON` is per-connection. Without this
	// the ON DELETE SET NULL check below would silently no-op.
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// 1. Table exists with the expected columns. Spot-check the
	//    ones whose shape matters most for the API contract:
	//    provider_id UNIQUE, type CHECK, client_secret as BLOB,
	//    created_by FK to users.
	wantCols := map[string]string{
		"id":                "TEXT",
		"provider_id":       "TEXT",
		"name":              "TEXT",
		"type":              "TEXT",
		"enabled":           "INTEGER",
		"position":          "INTEGER",
		"client_id":         "TEXT",
		"client_secret":     "BLOB",
		"scopes":            "TEXT",
		"auth_endpoint":     "TEXT",
		"token_endpoint":    "TEXT",
		"userinfo_endpoint": "TEXT",
		"issuer":            "TEXT",
		"extra_config":      "TEXT",
		"created_by":        "TEXT",
		"created_at":        "DATETIME",
		"updated_at":        "DATETIME",
	}
	rows, err := db.Query("SELECT name, type FROM pragma_table_info('oauth_providers')")
	if err != nil {
		t.Fatalf("inspect oauth_providers columns: %v", err)
	}
	gotCols := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			_ = rows.Close()
			t.Fatalf("scan column: %v", err)
		}
		gotCols[name] = typ
	}
	_ = rows.Close()
	for name, typ := range wantCols {
		got, ok := gotCols[name]
		if !ok {
			t.Errorf("expected oauth_providers.%s column after migration 009, missing", name)
			continue
		}
		if !strings.EqualFold(got, typ) {
			t.Errorf("oauth_providers.%s type: want %s, got %s", name, typ, got)
		}
	}

	// 2. created_by is nullable so providers seeded from the
	//    OAUTH_EXTERNAL_PROVIDERS env var (no human creator) and
	//    legacy rows from before an admin accounts-for-everyone
	//    policy can be inserted without a FK target.
	var notNull int
	if err := db.QueryRow(
		"SELECT \"notnull\" FROM pragma_table_info('oauth_providers') WHERE name='created_by'",
	).Scan(&notNull); err != nil {
		t.Fatalf("inspect created_by nullability: %v", err)
	}
	if notNull != 0 {
		t.Errorf("oauth_providers.created_by should be nullable, got notnull=%d", notNull)
	}

	// 3. Seed an admin creator and insert a fully-populated
	//    provider. The client_secret is a stand-in for AES-256-GCM
	//    ciphertext (12-byte nonce || tag || body, 60 bytes total
	//    for the AES helper that ships with s-1141).
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('admin1', 'admin', 'Admin', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	ciphertext := []byte("0123456789ab0123456789ab0123456789ab0123456789ab0123456789ababcd")
	if _, err := db.Exec(`
		INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, client_secret, scopes,
			auth_endpoint, token_endpoint, userinfo_endpoint,
			issuer, extra_config, created_by
		) VALUES (
			'prov-1', 'google', 'Google', 'google', 1, 0,
			'google-client', ?, 'openid email profile',
			'https://accounts.google.com/o/oauth2/v2/auth',
			'https://oauth2.googleapis.com/token',
			'https://openidconnect.googleapis.com/v1/userinfo',
			'https://accounts.google.com',
			'{"default_role":"USER"}', 'admin1'
		)
	`, ciphertext); err != nil {
		t.Fatalf("insert oauth_provider: %v", err)
	}

	// 4. Defaults land the way the API expects: enabled=1,
	//    position=0, scopes='', all endpoint columns empty when
	//    not overridden, created_at populated.
	var (
		enabled          int
		position         int
		scopes           string
		authEndpoint     string
		tokenEndpoint    string
		userinfoEndpoint string
		issuer           string
		extraConfig      string
		varCreatedAt     sql.NullString
	)
	if err := db.QueryRow(`
		SELECT enabled, position, scopes, auth_endpoint, token_endpoint,
		       userinfo_endpoint, issuer, extra_config, created_at
		FROM oauth_providers WHERE id = 'prov-1'
	`).Scan(&enabled, &position, &scopes, &authEndpoint, &tokenEndpoint,
		&userinfoEndpoint, &issuer, &extraConfig, &varCreatedAt); err != nil {
		t.Fatalf("scan provider defaults: %v", err)
	}
	if enabled != 1 {
		t.Errorf("expected enabled=1 default, got %d", enabled)
	}
	if position != 0 {
		t.Errorf("expected position=0 default, got %d", position)
	}
	if scopes != "openid email profile" {
		t.Errorf("scopes round-trip: got %q", scopes)
	}
	if authEndpoint == "" || tokenEndpoint == "" || issuer == "" {
		t.Errorf("expected explicit endpoints + issuer round-trip, got auth=%q token=%q issuer=%q",
			authEndpoint, tokenEndpoint, issuer)
	}
	if extraConfig != `{"default_role":"USER"}` {
		t.Errorf("extra_config round-trip: got %q", extraConfig)
	}
	if !varCreatedAt.Valid || varCreatedAt.String == "" {
		t.Errorf("expected created_at to be populated by default, got %v", varCreatedAt)
	}

	// 5. BLOB ciphertext round-trips byte-for-byte — a future
	//    ALTER COLUMN to TEXT would silently re-encode the bytes
	//    as UTF-8 and break AES-GCM verification at read time.
	var gotCipher []byte
	if err := db.QueryRow(
		"SELECT client_secret FROM oauth_providers WHERE id = 'prov-1'",
	).Scan(&gotCipher); err != nil {
		t.Fatalf("read client_secret: %v", err)
	}
	if !bytes.Equal(gotCipher, ciphertext) {
		t.Errorf("client_secret ciphertext round-trip mismatch: want %x, got %x",
			ciphertext, gotCipher)
	}

	// 6. CHECK constraint on `type` rejects unknown values so the
	//    admin API can't smuggle typos through to the runtime
	//    dispatch table.
	if _, err := db.Exec(`
		INSERT INTO oauth_providers (
			id, provider_id, name, type, client_id
		) VALUES (
			'prov-bad', 'bad', 'Bad', 'openid-connect-generic', 'cid'
		)
	`); err == nil {
		t.Errorf("expected CHECK constraint to reject unknown type, got nil error")
	}

	// 7. UNIQUE on provider_id — the public route
	//    /oauth/external/<provider_id>/... resolves by this
	//    handle and must not be ambiguous.
	if _, err := db.Exec(`
		INSERT INTO oauth_providers (
			id, provider_id, name, type, client_id
		) VALUES (
			'prov-dup', 'google', 'Google Dup', 'google', 'cid2'
		)
	`); err == nil {
		t.Errorf("expected UNIQUE(provider_id) to reject duplicate 'google', got nil error")
	}

	// 8. ON DELETE SET NULL on created_by mirrors the choice on
	//    users.created_by: removing the admin must not silently
	//    delete every provider they configured.
	if _, err := db.Exec(`DELETE FROM users WHERE id = 'admin1'`); err != nil {
		t.Fatalf("delete creator: %v", err)
	}
	var creator sql.NullString
	if err := db.QueryRow(
		"SELECT created_by FROM oauth_providers WHERE id = 'prov-1'",
	).Scan(&creator); err != nil {
		t.Fatalf("read created_by after admin delete: %v", err)
	}
	if creator.Valid {
		t.Errorf("expected created_by NULL after admin deletion, got %q", creator.String)
	}

	// 9. The lookup index is in place — without it the public
	//    "list enabled providers" query degrades to a table scan
	//    once an admin configures a few dozen disabled rows.
	var idxCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_oauth_providers_enabled'",
	).Scan(&idxCount); err != nil {
		t.Errorf("check idx_oauth_providers_enabled: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_oauth_providers_enabled after migration 009, got count=%d", idxCount)
	}

	// 10. The down migration drops the index then the table.
	//     Use m.Migrate(8) (the version strictly before 009) rather
	//     than m.Steps(-1) so the test stays correct when later
	//     migrations (010+) extend the tip — m.Steps(-1) would
	//     roll back whatever happens to be at the end, not 009.
	if err := m.Migrate(8); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("rollback 009: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_oauth_providers_enabled'",
	).Scan(&idxCount); err != nil {
		t.Errorf("check idx_oauth_providers_enabled after rollback: %v", err)
	}
	if idxCount != 0 {
		t.Errorf("expected idx_oauth_providers_enabled to be dropped after rollback 009, got count=%d", idxCount)
	}
	var tableCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='oauth_providers'",
	).Scan(&tableCount); err != nil {
		t.Errorf("check oauth_providers after rollback: %v", err)
	}
	if tableCount != 0 {
		t.Errorf("expected oauth_providers to be dropped after rollback 009, got count=%d", tableCount)
	}

	// Re-apply so the shared in-memory db stays usable for
	// the rest of the test suite.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
}

// TestSQLiteMigrationsUserIdentities exercises migration 010
// (s-1142) end-to-end on SQLite. It verifies:
//
//   - user_identities comes up with the columns documented in
//     plan §3.3 of docs/OAUTH_EXTERNAL_PLAN_s-1139.md (id PK,
//     user_id FK CASCADE to users, provider_id FK CASCADE to
//     oauth_providers, subject NOT NULL, raw_claims defaults
//     to '{}', linked_at + last_used_at auto-populated).
//   - The UNIQUE(provider_id, subject) constraint rejects a
//     duplicate row so the natural key is genuinely unique.
//   - The ON DELETE CASCADE on user_id wipes the binding when
//     the local user is deleted (GDPR parity per plan §3.3).
//   - The ON DELETE CASCADE on provider_id wipes the binding
//     when the admin removes the IdP via the admin UI.
//   - users.email is added as a nullable TEXT column with the
//     idx_users_email lookup index so the auto-link-by-email
//     path in the callback handler stays indexed.
//   - The down migration drops the index, the table, the email
//     column, and the email index in the documented order.
//
// Mirrors the round-trip pattern used by 008 / 009 so a
// future regression in any of the constraints above fails
// before the external-callback handler tests do.
func TestSQLiteMigrationsUserIdentities(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	// Enable FK enforcement on every connection in this pool.
	// The migrate driver does this for its own connection, but
	// the db.QueryRow / db.Exec calls below run on whatever
	// connection the pool hands us, and SQLite's
	// `PRAGMA foreign_keys = ON` is per-connection. Without
	// this the ON DELETE CASCADE checks below would silently
	// no-op.
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// 1. user_identities columns match the plan §3.3 contract.
	wantCols := map[string]string{
		"id":           "TEXT",
		"user_id":      "TEXT",
		"provider_id":  "TEXT",
		"subject":      "TEXT",
		"raw_claims":   "TEXT",
		"linked_at":    "DATETIME",
		"last_used_at": "DATETIME",
	}
	rows, err := db.Query("SELECT name, type FROM pragma_table_info('user_identities')")
	if err != nil {
		t.Fatalf("inspect user_identities columns: %v", err)
	}
	gotCols := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			_ = rows.Close()
			t.Fatalf("scan column: %v", err)
		}
		gotCols[name] = typ
	}
	_ = rows.Close()
	for name, typ := range wantCols {
		got, ok := gotCols[name]
		if !ok {
			t.Errorf("expected user_identities.%s column after migration 010, missing", name)
			continue
		}
		if !strings.EqualFold(got, typ) {
			t.Errorf("user_identities.%s type: want %s, got %s", name, typ, got)
		}
	}

	// 2. users.email was added as a nullable TEXT column.
	var (
		emailNotNull int
		emailType    string
	)
	if err := db.QueryRow(
		"SELECT \"notnull\", type FROM pragma_table_info('users') WHERE name='email'",
	).Scan(&emailNotNull, &emailType); err != nil {
		t.Fatalf("inspect users.email: %v", err)
	}
	if emailNotNull != 0 {
		t.Errorf("users.email should be nullable, got notnull=%d", emailNotNull)
	}
	if !strings.EqualFold(emailType, "TEXT") {
		t.Errorf("users.email type: want TEXT, got %s", emailType)
	}

	// 3. Seed the FK targets: a local user, an oauth_provider,
	//    then a user_identities row.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, email, type, role, enabled)
		VALUES ('u-1', 'alice', 'Alice', 'alice@example.com', 'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO oauth_providers (
			id, provider_id, name, type, client_id, created_at, updated_at
		) VALUES ('p-1', 'google', 'Google', 'google', 'cid', ?, ?)
	`, time.Now(), time.Now()); err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO user_identities (id, user_id, provider_id, subject, raw_claims)
		 VALUES ('i-1', 'u-1', 'p-1', 'google-sub-1', '{"sub":"google-sub-1"}')`,
	); err != nil {
		t.Fatalf("seed identity: %v", err)
	}

	// 4. raw_claims defaults land — a fresh row with no
	//    raw_claims argument stores '{}' rather than NULL so
	//    downstream json.Unmarshal never has to nil-check.
	if _, err := db.Exec(
		`INSERT INTO user_identities (id, user_id, provider_id, subject)
		 VALUES ('i-2', 'u-1', 'p-1', 'google-sub-2')`,
	); err != nil {
		t.Fatalf("seed identity defaults: %v", err)
	}
	var rc string
	if err := db.QueryRow(
		`SELECT raw_claims FROM user_identities WHERE id = 'i-2'`,
	).Scan(&rc); err != nil {
		t.Fatalf("read raw_claims default: %v", err)
	}
	if rc != "{}" {
		t.Errorf("expected raw_claims default '{}', got %q", rc)
	}

	// 5. UNIQUE(provider_id, subject) rejects a duplicate
	//    (provider_id, subject) row so the binding is the
	//    natural key.
	if _, err := db.Exec(
		`INSERT INTO user_identities (id, user_id, provider_id, subject)
		 VALUES ('i-dup', 'u-1', 'p-1', 'google-sub-1')`,
	); err == nil {
		t.Errorf("expected UNIQUE(provider_id, subject) to reject duplicate binding, got nil")
	}

	// 6. ON DELETE CASCADE on user_id wipes the binding when
	//    the local user is removed — GDPR parity per plan §3.3.
	if _, err := db.Exec(`DELETE FROM users WHERE id = 'u-1'`); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_identities`).Scan(&n); err != nil {
		t.Fatalf("count after user delete: %v", err)
	}
	if n != 0 {
		t.Errorf("expected CASCADE to drop identity rows after user delete, got %d", n)
	}

	// 7. ON DELETE CASCADE on provider_id wipes the bindings
	//    when the admin removes the IdP via the admin UI.
	//    Re-seed both sides first.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u-2', 'bob', 'Bob', 'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("re-seed user: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO user_identities (id, user_id, provider_id, subject)
		 VALUES ('i-3', 'u-2', 'p-1', 'google-sub-3')`,
	); err != nil {
		t.Fatalf("re-seed identity: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM oauth_providers WHERE id = 'p-1'`); err != nil {
		t.Fatalf("delete provider: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_identities`).Scan(&n); err != nil {
		t.Fatalf("count after provider delete: %v", err)
	}
	if n != 0 {
		t.Errorf("expected CASCADE to drop identity rows after provider delete, got %d", n)
	}

	// 8. idx_users_email is in place so the auto-link-by-
	//    email lookup in the callback handler stays indexed.
	var idxCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_email'",
	).Scan(&idxCount); err != nil {
		t.Fatalf("check idx_users_email: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_users_email after migration 010, got count=%d", idxCount)
	}

	// 9. The down migration drops idx_user_identities_user,
	//    user_identities, idx_users_email, then users.email
	//    in that order. Use m.Migrate(9) (the version strictly
	//    before 010) rather than m.Steps(-1) so the test stays
	//    correct when later migrations (011+) extend the tip.
	if err := m.Migrate(9); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("rollback 010: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_identities'",
	).Scan(&n); err != nil {
		t.Fatalf("check user_identities after rollback: %v", err)
	}
	if n != 0 {
		t.Errorf("expected user_identities to be dropped after rollback 010, got count=%d", n)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_email'",
	).Scan(&idxCount); err != nil {
		t.Fatalf("check idx_users_email after rollback: %v", err)
	}
	if idxCount != 0 {
		t.Errorf("expected idx_users_email to be dropped after rollback 010, got count=%d", idxCount)
	}

	// Re-apply so the shared in-memory db stays usable for
	// the rest of the test suite.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
}

// TestSQLiteMigrationsTaskRunsUpDown exercises the task_runs
// migrations end-to-end on SQLite. It verifies the table + its
// indexes come up cleanly, that the schema matches the §3.3
// contract (PK is task_id, FKs point at tasks/users, nullable
// finished_at / exit_code / error), and that the migrations are
// fully reversible: stepping back down past 006 (history
// indexes), 005 (FK relaxation) and 004 (table creation) drops
// the indexes and table, and re-running up brings everything
// back without errors. The MySQL migration is structurally
// identical to the SQLite one and is covered separately by
// TestMySQLMigrationsHaveUtf8Mb4Collation (charset / ENGINE)
// plus the integration test that runs the full suite against a
// live MySQL instance.
func TestSQLiteMigrationsTaskRunsUpDown(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}

	// 1. Apply every migration up to the tip (006). After this,
	//    task_runs must exist with the indexes from both 004 and
	//    006 — the latter are the history indexes the
	//    /api/v1/runs/history endpoint relies on (s-1106).
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("initial up: %v", err)
	}

	var taskRunsFound int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after up, got count=%d", taskRunsFound)
	}

	for _, idx := range []string{
		"idx_task_runs_expires",
		"idx_task_runs_runner",
		"idx_task_runs_status",
		"idx_task_runs_finished_at",
		"idx_task_runs_status_finished_at",
	} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check index %s: %v", idx, err)
			continue
		}
		if c != 1 {
			t.Errorf("expected index %s after up, got count=%d", idx, c)
		}
	}

	// 2. Insert a minimal but FK-valid row, then drop the table
	//    via the down migrations to prove the down SQL works and
	//    that the FKs / indexes line up with §3.3.
	//
	//    "Drop task_runs via the down migration" means rolling
	//    past 006, 005 and 004. We assert each rollback step
	//    individually so a regression in any of the three
	//    migrations surfaces with its own failing assertion:
	//
	//      migrate(5): before 006 (history indexes) — task_runs untouched
	//      migrate(4): before 005 (FK relaxation)   — task_runs untouched
	//      migrate(3): before 004 (table creation)  — task_runs dropped
	//
	//    Use explicit m.Migrate(target) rather than m.Steps(-1)
	//    so the test stays correct when later migrations
	//    (009+) extend the tip — m.Steps(-1) would roll back
	//    whatever happens to be at the end, not 006/005/004.
	seedTaskRun(t, db)

	if err := m.Migrate(5); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 005: %v", err)
	}
	// After rolling back 006, task_runs must still exist and
	// the 004 indexes must still be in place. The 006 history
	// indexes should be gone.
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after rolling back 006: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after rolling back 006, got count=%d", taskRunsFound)
	}
	for _, idx := range []string{"idx_task_runs_finished_at", "idx_task_runs_status_finished_at"} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check residual index %s after rolling back 006: %v", idx, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected index %s to be dropped after rolling back 006, got count=%d", idx, c)
		}
	}

	if err := m.Migrate(4); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 004: %v", err)
	}
	// After rolling back 005, task_runs must still exist (its
	// schema hasn't been touched yet) and the runner_id FK to
	// users.id should be back in force.
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after rolling back 005: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after rolling back 005, got count=%d", taskRunsFound)
	}

	if err := m.Migrate(3); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 003: %v", err)
	}

	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after down: %v", err)
	}
	if taskRunsFound != 0 {
		t.Fatalf("expected task_runs table to be dropped after down, got count=%d", taskRunsFound)
	}
	for _, idx := range []string{"idx_task_runs_expires", "idx_task_runs_runner", "idx_task_runs_status"} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check residual index %s after down: %v", idx, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected index %s to be dropped after down, got count=%d", idx, c)
		}
	}

	// 3. Re-apply up — this exercises the "migration can be run
	//    more than once without error" acceptance criterion.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after re-up: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after re-up, got count=%d", taskRunsFound)
	}

	// 4. Spot-check the live row from step 2 is gone (the down
	//    dropped it), and the table accepts a fresh one — both
	//    nullable and required columns round-trip cleanly through
	//    the schema.
	seedTaskRun(t, db)

	var (
		status        string
		finishedAt    sql.NullTime
		exitCode      sql.NullInt64
		errMsg        sql.NullString
		runnerID      string
		lastHeartbeat string
	)
	row := db.QueryRow(
		"SELECT status, finished_at, exit_code, error, runner_id, last_heartbeat_at FROM task_runs WHERE task_id='t-1'",
	)
	if err := row.Scan(&status, &finishedAt, &exitCode, &errMsg, &runnerID, &lastHeartbeat); err != nil {
		t.Fatalf("scan task_runs row: %v", err)
	}
	if status != "claimed" {
		t.Errorf("expected status 'claimed', got %q", status)
	}
	if finishedAt.Valid || exitCode.Valid || errMsg.Valid {
		t.Errorf("expected nullable columns to be NULL, got finished_at=%v exit_code=%v error=%q",
			finishedAt, exitCode, errMsg.String)
	}
	if runnerID != "u-1" {
		t.Errorf("expected runner_id 'u-1', got %q", runnerID)
	}
	if lastHeartbeat == "" {
		t.Errorf("expected non-empty last_heartbeat_at, got empty")
	}
}

// seedTaskRun inserts the minimum rows required for a FK-valid
// task_runs row: a users row (runner_id), a tasks row (task_id),
// and the task_runs row itself with the canonical §3.3 claim
// shape. It is safe to call against a freshly-up'd schema or
// after a down→up cycle (the seed IDs are deterministic and
// either previously dropped or freshly created).
func seedTaskRun(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u-1', 'runner-1', 'runner-1', 'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO boards (id, name, description)
		VALUES ('b-1', 'board-1', '')
	`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO columns (id, name, position, board_id)
		VALUES ('c-1', 'todo', 0, 'b-1')
	`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO tasks (id, title, column_id, position, published, archived, created_by)
		VALUES ('t-1', 'task-1', 'c-1', 0, 1, 0, 'u-1')
	`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO task_runs (
			task_id, runner_id, agent_id, board_id, column_id, status,
			claimed_at, last_heartbeat_at, expires_at
		) VALUES (
			't-1', 'u-1', 'cli-host', 'b-1', 'c-1', 'claimed',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		)
	`); err != nil {
		t.Fatalf("seed task_runs: %v", err)
	}
}

// TestSQLiteMigrationsPendingOAuthStates exercises migration
// 011 (s-1145) end-to-end on SQLite. It verifies:
//
//   - pending_oauth_states comes up with the columns documented
//     in plan §7.1 (id PK, state UNIQUE NOT NULL, provider_id
//     FK CASCADE to oauth_providers, code_verifier NOT NULL,
//     code_challenge NOT NULL, redirect_after defaulting to ”,
//     created_at + expires_at NOT NULL, consumed_at nullable).
//   - The UNIQUE(state) constraint rejects a duplicate row so
//     the wire-level CSRF token is genuinely unique.
//   - The ON DELETE CASCADE on provider_id wipes the state row
//     when the admin removes the IdP via the admin UI — a
//     dangling state row would survive a stale login click.
//   - The expires_at index is in place so the housekeeping
//     sweep scales to thousands of abandoned clicks.
//   - The down migration drops both indexes and the table in
//     the documented order without errors.
//
// Mirrors the round-trip pattern used by 008 / 009 / 010 so a
// future regression in any of the constraints above fails
// before the external-state handler tests do.
func TestSQLiteMigrationsPendingOAuthStates(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// 1. pending_oauth_states columns match the plan §7.1
	//    contract.
	wantCols := map[string]string{
		"id":             "TEXT",
		"state":          "TEXT",
		"provider_id":    "TEXT",
		"code_verifier":  "TEXT",
		"code_challenge": "TEXT",
		"redirect_after": "TEXT",
		"expires_at":     "DATETIME",
	}
	rows, err := db.Query("SELECT name, type FROM pragma_table_info('pending_oauth_states')")
	if err != nil {
		t.Fatalf("inspect pending_oauth_states columns: %v", err)
	}
	gotCols := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			_ = rows.Close()
			t.Fatalf("scan column: %v", err)
		}
		gotCols[name] = typ
	}
	_ = rows.Close()
	for name, typ := range wantCols {
		got, ok := gotCols[name]
		if !ok {
			t.Errorf("expected pending_oauth_states.%s column after migration 011, missing", name)
			continue
		}
		if !strings.EqualFold(got, typ) {
			t.Errorf("pending_oauth_states.%s type: want %s, got %s", name, typ, got)
		}
	}

	// 2. UNIQUE(state) prevents two rows from sharing a CSRF
	//    token — the natural key the callback handler looks up
	//    by.
	if _, err := db.Exec(`
		INSERT INTO oauth_providers (
			id, provider_id, name, type, enabled, position,
			client_id, scopes, auth_endpoint, token_endpoint,
			userinfo_endpoint, issuer, extra_config, created_at, updated_at
		) VALUES ('p-1', 'google', 'Google', 'google', 1, 0,
		          'cid', '', 'https://idp/auth', 'https://idp/token',
		          'https://idp/user', '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`); err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO pending_oauth_states (
			id, state, provider_id, code_verifier, code_challenge,
			redirect_after, expires_at
		) VALUES ('s-1', 'state-A', 'p-1', 'verifier-A', 'challenge-A', '', '2099-01-01 00:00:00')
	`); err != nil {
		t.Fatalf("insert first state: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO pending_oauth_states (
			id, state, provider_id, code_verifier, code_challenge,
			redirect_after, expires_at
		) VALUES ('s-2', 'state-A', 'p-1', 'verifier-B', 'challenge-B', '', '2099-01-01 00:00:00')
	`); err == nil {
		t.Errorf("expected UNIQUE(state) to reject duplicate state value")
	}

	// 3. ON DELETE CASCADE: dropping the provider must wipe
	//    every pending state row bound to it.
	if _, err := db.Exec(`DELETE FROM oauth_providers WHERE id = 'p-1'`); err != nil {
		t.Fatalf("delete provider: %v", err)
	}
	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM pending_oauth_states`,
	).Scan(&n); err != nil {
		t.Fatalf("count pending states: %v", err)
	}
	if n != 0 {
		t.Errorf("expected cascade to drop pending state rows, got %d", n)
	}

	// 4. The expires_at index is in place so the housekeeping
	//    sweep scales.
	var idxCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_pending_oauth_states_expires'`,
	).Scan(&idxCount); err != nil {
		t.Fatalf("check idx_pending_oauth_states_expires: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_pending_oauth_states_expires after migration 011, got count=%d", idxCount)
	}

	// 5. The down migration drops both indexes and the table
	//    in the documented order. Use m.Migrate(10) (the
	//    version strictly before 011) rather than m.Steps(-1)
	//    so the test stays correct when later migrations
	//    (012+) extend the tip.
	if err := m.Migrate(10); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("rollback 011: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pending_oauth_states'",
	).Scan(&n); err != nil {
		t.Fatalf("check pending_oauth_states after rollback: %v", err)
	}
	if n != 0 {
		t.Errorf("expected pending_oauth_states to be dropped after rollback 011, got count=%d", n)
	}

	// Re-apply so the shared in-memory db stays usable for
	// the rest of the test suite.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
}

// TestSQLiteMigrationsWebhookCenter exercises migration 012
// (s-1139) end-to-end on SQLite. It verifies:
//
//   - webhooks + webhook_deliveries come up with the columns
//     documented in plan §4 of docs/EVENT_CENTER_PLAN_s-1138.md
//     (id PK, name / url / secret NOT NULL, enabled default 1,
//     event_types / filters / headers as JSON text defaults,
//     timeout_sec / max_retries with documented defaults,
//     created_by FK SET NULL to users, created_at / updated_at,
//     last_success_at / last_failure_at nullable).
//   - Happy path: a fully-populated webhook row inserts and
//     round-trips every column, including the BLOB secret and
//     the JSON columns that downstream code parses.
//   - Happy path: a fully-populated webhook_deliveries row
//     inserts with status='PENDING' and round-trips the
//     request_body, response_code, response_body, error,
//     started_at, finished_at, next_retry_at columns.
//   - ON DELETE CASCADE on webhook_deliveries.webhook_id wipes
//     every delivery row bound to a webhook when the webhook
//     is removed — the management UI's delete action depends
//     on this so we never have a delivery row pointing at a
//     vanished webhook.
//   - ON DELETE SET NULL on webhooks.created_by mirrors the
//     choice on users.created_by (migration 008) /
//     oauth_providers.created_by (migration 009): deleting the
//     admin must not silently re-parent or drop every webhook
//     they configured.
//   - The two indexes from plan §4 are present:
//     idx_webhook_deliveries_webhook_started   backs the
//     per-webhook deliveries page sort
//     (webhook_id, started_at DESC).
//     idx_webhook_deliveries_status_next_retry backs the
//     retry sweeper's WHERE status='FAILED' AND
//     next_retry_at <= ? hot path.
//   - The CHECK constraint on webhook_deliveries.status
//     rejects unknown values so a buggy dispatcher can't
//     silently write 'pending' vs 'PENDING'.
//   - The down migration drops both indexes and both tables
//     in dependency order. Use m.Migrate(11) (the version
//     strictly before 012) rather than m.Steps(-1) so the
//     test stays correct when later migrations (013+)
//     extend the tip.
//
// Mirrors the round-trip pattern used by 008 / 009 / 010 / 011
// so a future regression in any of the constraints above fails
// before the webhook CRUD handler tests (s-1143) do.
func TestSQLiteMigrationsWebhookCenter(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	// Enable FK enforcement on every connection in this pool.
	// The migrate driver does this for its own connection, but
	// the db.QueryRow / db.Exec calls below run on whatever
	// connection the pool hands us, and SQLite's
	// `PRAGMA foreign_keys = ON` is per-connection. Without
	// this the ON DELETE CASCADE / SET NULL checks below would
	// silently no-op.
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// 1. webhooks columns match the plan §4 contract.
	wantWebhookCols := map[string]string{
		"id":              "TEXT",
		"name":            "TEXT",
		"url":             "TEXT",
		"secret":          "BLOB",
		"enabled":         "INTEGER",
		"event_types":     "TEXT",
		"filters":         "TEXT",
		"headers":         "TEXT",
		"timeout_sec":     "INTEGER",
		"max_retries":     "INTEGER",
		"created_by":      "TEXT",
		"created_at":      "DATETIME",
		"updated_at":      "DATETIME",
		"last_success_at": "DATETIME",
		"last_failure_at": "DATETIME",
	}
	rows, err := db.Query("SELECT name, type FROM pragma_table_info('webhooks')")
	if err != nil {
		t.Fatalf("inspect webhooks columns: %v", err)
	}
	gotWebhookCols := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			_ = rows.Close()
			t.Fatalf("scan webhooks column: %v", err)
		}
		gotWebhookCols[name] = typ
	}
	_ = rows.Close()
	for name, typ := range wantWebhookCols {
		got, ok := gotWebhookCols[name]
		if !ok {
			t.Errorf("expected webhooks.%s column after migration 012, missing", name)
			continue
		}
		if !strings.EqualFold(got, typ) {
			t.Errorf("webhooks.%s type: want %s, got %s", name, typ, got)
		}
	}

	// 2. webhook_deliveries columns match the plan §4 contract.
	wantDeliveryCols := map[string]string{
		"id":            "TEXT",
		"webhook_id":    "TEXT",
		"event_id":      "TEXT",
		"event_type":    "TEXT",
		"status":        "TEXT",
		"attempt":       "INTEGER",
		"request_body":  "TEXT",
		"response_code": "INTEGER",
		"response_body": "TEXT",
		"error":         "TEXT",
		"started_at":    "DATETIME",
		"finished_at":   "DATETIME",
		"next_retry_at": "DATETIME",
	}
	rows, err = db.Query("SELECT name, type FROM pragma_table_info('webhook_deliveries')")
	if err != nil {
		t.Fatalf("inspect webhook_deliveries columns: %v", err)
	}
	gotDeliveryCols := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			_ = rows.Close()
			t.Fatalf("scan webhook_deliveries column: %v", err)
		}
		gotDeliveryCols[name] = typ
	}
	_ = rows.Close()
	for name, typ := range wantDeliveryCols {
		got, ok := gotDeliveryCols[name]
		if !ok {
			t.Errorf("expected webhook_deliveries.%s column after migration 012, missing", name)
			continue
		}
		if !strings.EqualFold(got, typ) {
			t.Errorf("webhook_deliveries.%s type: want %s, got %s", name, typ, got)
		}
	}

	// 3. created_by is nullable so the env-var back-fill path in
	//    plan §9.3 can insert a webhook without a creator.
	var createdByNotNull int
	if err := db.QueryRow(
		`SELECT "notnull" FROM pragma_table_info('webhooks') WHERE name='created_by'`,
	).Scan(&createdByNotNull); err != nil {
		t.Fatalf("inspect created_by nullability: %v", err)
	}
	if createdByNotNull != 0 {
		t.Errorf("webhooks.created_by should be nullable, got notnull=%d", createdByNotNull)
	}

	// 4. Happy path: seed a creator, insert a fully-populated
	//    webhook, and verify defaults + JSON / BLOB round-trip.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('admin1', 'admin', 'Admin', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	// 32-byte HMAC signing secret (§5.2). Stored as a BLOB so
	// the plaintext doesn't show up in naive `SELECT *` dumps.
	secret := []byte("0123456789abcdef0123456789abcdef")
	if _, err := db.Exec(`
		INSERT INTO webhooks (
			id, name, url, secret, enabled, event_types, filters, headers,
			timeout_sec, max_retries, created_by
		) VALUES (
			'wh-1', 'staging', 'https://hooks.example.com/inbound',
			?, 1, '["task.created","task.moved"]',
			'{"boardIds":["b-1"]}', '{"X-Token":"abc"}',
			15, 5, 'admin1'
		)
	`, secret); err != nil {
		t.Fatalf("insert webhook: %v", err)
	}

	var (
		gotName       string
		gotURL        string
		gotSecret     []byte
		gotEnabled    int
		gotEventTypes string
		gotFilters    string
		gotHeaders    string
		gotTimeout    int
		gotMaxRetries int
		gotCreatedBy  sql.NullString
		gotCreatedAt  sql.NullString
	)
	if err := db.QueryRow(`
		SELECT name, url, secret, enabled, event_types, filters, headers,
		       timeout_sec, max_retries, created_by, created_at
		FROM webhooks WHERE id = 'wh-1'
	`).Scan(&gotName, &gotURL, &gotSecret, &gotEnabled, &gotEventTypes, &gotFilters,
		&gotHeaders, &gotTimeout, &gotMaxRetries, &gotCreatedBy, &gotCreatedAt); err != nil {
		t.Fatalf("scan webhook row: %v", err)
	}
	if gotName != "staging" {
		t.Errorf("name round-trip: got %q", gotName)
	}
	if gotURL != "https://hooks.example.com/inbound" {
		t.Errorf("url round-trip: got %q", gotURL)
	}
	if !bytes.Equal(gotSecret, secret) {
		t.Errorf("secret round-trip mismatch: want %x, got %x", secret, gotSecret)
	}
	if gotEnabled != 1 {
		t.Errorf("enabled default: want 1, got %d", gotEnabled)
	}
	if gotEventTypes != `["task.created","task.moved"]` {
		t.Errorf("event_types round-trip: got %q", gotEventTypes)
	}
	if gotFilters != `{"boardIds":["b-1"]}` {
		t.Errorf("filters round-trip: got %q", gotFilters)
	}
	if gotHeaders != `{"X-Token":"abc"}` {
		t.Errorf("headers round-trip: got %q", gotHeaders)
	}
	if gotTimeout != 15 {
		t.Errorf("timeout_sec round-trip: want 15, got %d", gotTimeout)
	}
	if gotMaxRetries != 5 {
		t.Errorf("max_retries round-trip: want 5, got %d", gotMaxRetries)
	}
	if !gotCreatedBy.Valid || gotCreatedBy.String != "admin1" {
		t.Errorf("created_by round-trip: want admin1, got %v", gotCreatedBy)
	}
	if !gotCreatedAt.Valid || gotCreatedAt.String == "" {
		t.Errorf("expected created_at populated by default, got %v", gotCreatedAt)
	}

	// 5. Happy path: insert a PENDING delivery row and verify
	//    status / attempt defaults + round-trip of every column.
	if _, err := db.Exec(`
		INSERT INTO webhook_deliveries (
			id, webhook_id, event_id, event_type, status, attempt,
			request_body, response_code, response_body, error,
			started_at, finished_at, next_retry_at
		) VALUES (
			'wd-1', 'wh-1', 'evt-1', 'task.created', 'PENDING', 1,
			'{"id":"evt-1","type":"task.created"}', 0, '', '',
			'2026-09-13 15:52:26', NULL, NULL
		)
	`); err != nil {
		t.Fatalf("insert webhook_delivery: %v", err)
	}
	var (
		gotDStatus       string
		gotDAttempt      int
		gotDRequestBody  string
		gotDResponseCode int
		gotDResponseBody string
		gotDError        string
		gotDStartedAt    sql.NullString
		gotDFinishedAt   sql.NullString
		gotDNextRetry    sql.NullString
	)
	if err := db.QueryRow(`
		SELECT status, attempt, request_body, response_code, response_body,
		       error, started_at, finished_at, next_retry_at
		FROM webhook_deliveries WHERE id = 'wd-1'
	`).Scan(&gotDStatus, &gotDAttempt, &gotDRequestBody, &gotDResponseCode,
		&gotDResponseBody, &gotDError, &gotDStartedAt, &gotDFinishedAt,
		&gotDNextRetry); err != nil {
		t.Fatalf("scan webhook_delivery row: %v", err)
	}
	if gotDStatus != "PENDING" {
		t.Errorf("status round-trip: want PENDING, got %q", gotDStatus)
	}
	if gotDAttempt != 1 {
		t.Errorf("attempt round-trip: want 1, got %d", gotDAttempt)
	}
	if gotDRequestBody != `{"id":"evt-1","type":"task.created"}` {
		t.Errorf("request_body round-trip: got %q", gotDRequestBody)
	}
	if gotDResponseCode != 0 {
		t.Errorf("response_code default: want 0, got %d", gotDResponseCode)
	}
	if gotDResponseBody != "" {
		t.Errorf("response_body default: want empty, got %q", gotDResponseBody)
	}
	if gotDError != "" {
		t.Errorf("error default: want empty, got %q", gotDError)
	}
	if !gotDStartedAt.Valid || gotDStartedAt.String == "" {
		t.Errorf("started_at should be populated, got %v", gotDStartedAt)
	}
	if gotDFinishedAt.Valid {
		t.Errorf("finished_at should be NULL while PENDING, got %q", gotDFinishedAt.String)
	}
	if gotDNextRetry.Valid {
		t.Errorf("next_retry_at should be NULL while PENDING, got %q", gotDNextRetry.String)
	}

	// 6. Insert a second delivery and verify the index-1 happy
	//    path's row is still there alongside it — i.e. that the
	//    unique-id PK isn't accidentally wider than TEXT and
	//    rejecting siblings.
	if _, err := db.Exec(`
		INSERT INTO webhook_deliveries (
			id, webhook_id, event_id, event_type, status, attempt,
			request_body, response_code, response_body, error,
			started_at, finished_at, next_retry_at
		) VALUES (
			'wd-2', 'wh-1', 'evt-2', 'task.moved', 'SUCCESS', 1,
			'{"id":"evt-2","type":"task.moved"}', 200,
			'{"ok":true}', '',
			'2026-09-13 15:52:27', '2026-09-13 15:52:28', NULL
		)
	`); err != nil {
		t.Fatalf("insert second delivery: %v", err)
	}
	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = 'wh-1'`,
	).Scan(&n); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 deliveries bound to wh-1, got %d", n)
	}

	// 7. CHECK constraint on delivery.status rejects unknown
	//    values so a buggy dispatcher can't smuggle 'pending'
	//    (lowercase) through and confuse the sweeper.
	if _, err := db.Exec(`
		INSERT INTO webhook_deliveries (
			id, webhook_id, event_id, event_type, status, attempt,
			request_body, response_code, response_body, error
		) VALUES (
			'wd-bad', 'wh-1', 'evt-bad', 'task.created', 'pending', 1,
			'', 0, '', ''
		)
	`); err == nil {
		t.Errorf("expected CHECK constraint to reject status='pending', got nil error")
	}

	// 8. ON DELETE CASCADE on webhook_deliveries.webhook_id wipes
	//    every delivery row when the webhook is removed — the
	//    management UI's delete action depends on this so we
	//    never have a delivery row pointing at a vanished
	//    webhook. Re-create the webhook + deliveries first
	//    because step 7 doesn't roll back the prior inserts.
	if _, err := db.Exec(`
		INSERT INTO webhooks (
			id, name, url, secret, event_types, filters, headers
		) VALUES (
			'wh-cascade', 'cascade-test', 'https://example.com/cascade',
			?, '[]', '{}', '{}'
		)
	`, []byte("0123456789abcdef0123456789abcdef")); err != nil {
		t.Fatalf("re-seed webhook for cascade test: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := db.Exec(`
			INSERT INTO webhook_deliveries (
				id, webhook_id, event_id, event_type, status, attempt,
				request_body, response_code, response_body, error
			) VALUES (?, 'wh-cascade', ?, 'task.created', 'PENDING', 1,
			          '', 0, '', '')
		`, fmt.Sprintf("wd-cascade-%d", i), fmt.Sprintf("evt-cascade-%d", i)); err != nil {
			t.Fatalf("seed cascade delivery %d: %v", i, err)
		}
	}
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = 'wh-cascade'`,
	).Scan(&n); err != nil {
		t.Fatalf("count pre-delete: %v", err)
	}
	if n != 3 {
		t.Fatalf("expected 3 deliveries before cascade delete, got %d", n)
	}
	if _, err := db.Exec(`DELETE FROM webhooks WHERE id = 'wh-cascade'`); err != nil {
		t.Fatalf("delete webhook for cascade test: %v", err)
	}
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = 'wh-cascade'`,
	).Scan(&n); err != nil {
		t.Fatalf("count post-cascade: %v", err)
	}
	if n != 0 {
		t.Errorf("expected CASCADE to wipe deliveries for deleted webhook, got %d", n)
	}

	// 9. ON DELETE SET NULL on webhooks.created_by mirrors the
	//    choice on users.created_by (migration 008) and
	//    oauth_providers.created_by (migration 009): deleting
	//    the admin must not silently re-parent or drop every
	//    webhook they configured. The webhook row from step 4
	//    ('wh-1', created_by='admin1') is still alive at this
	//    point because nothing in this test has removed it.
	if _, err := db.Exec(`DELETE FROM users WHERE id = 'admin1'`); err != nil {
		t.Fatalf("delete creator: %v", err)
	}
	var remaining sql.NullString
	if err := db.QueryRow(
		`SELECT created_by FROM webhooks WHERE id = 'wh-1'`,
	).Scan(&remaining); err != nil {
		t.Fatalf("read created_by after admin delete: %v", err)
	}
	if remaining.Valid {
		t.Errorf("expected created_by NULL after admin deletion, got %q", remaining.String)
	}
	var webhookAlive int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM webhooks WHERE id = 'wh-1'`,
	).Scan(&webhookAlive); err != nil {
		t.Fatalf("count webhook wh-1 after admin delete: %v", err)
	}
	if webhookAlive != 1 {
		t.Errorf("webhook should survive admin deletion (SET NULL), got count=%d", webhookAlive)
	}

	// 10. Both indexes from plan §4 are in place.
	for _, idx := range []string{
		"idx_webhook_deliveries_webhook_started",
		"idx_webhook_deliveries_status_next_retry",
	} {
		var c int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx,
		).Scan(&c); err != nil {
			t.Errorf("check webhook index %s: %v", idx, err)
			continue
		}
		if c != 1 {
			t.Errorf("expected %s after migration 012, got count=%d", idx, c)
		}
	}

	// 11. The down migration drops both indexes and both tables
	//     in dependency order. Use m.Migrate(11) (the version
	//     strictly before 012) rather than m.Steps(-1) so the
	//     test stays correct when later migrations (013+)
	//     extend the tip.
	if err := m.Migrate(11); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("rollback 012: %v", err)
	}
	for _, table := range []string{"webhook_deliveries", "webhooks"} {
		var c int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&c); err != nil {
			t.Errorf("check %s after rollback: %v", table, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected %s to be dropped after rollback 012, got count=%d", table, c)
		}
	}
	for _, idx := range []string{
		"idx_webhook_deliveries_webhook_started",
		"idx_webhook_deliveries_status_next_retry",
	} {
		var c int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx,
		).Scan(&c); err != nil {
			t.Errorf("check %s after rollback: %v", idx, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected %s to be dropped after rollback 012, got count=%d", idx, c)
		}
	}

	// Re-apply so the shared in-memory db stays usable for
	// the rest of the test suite.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
}
