package database_test

import (
	"database/sql"
	"testing"

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
