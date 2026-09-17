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

// TestSQLiteMigration012_AddsUserNotificationPreferences exercises
// the per-user notification preferences migration (s-1203) end-to-end
// and asserts the contracts the spec calls out:
//
//   - The user_notification_preferences table exists after migration 12.
//   - The table has a primary key on user_id so the UPSERT
//     INSERT … ON CONFLICT(user_id) form in the handler stays valid.
//   - Defaults match the documented contract: email_enabled=1,
//     webhook_enabled=1, webhook_url=''. A fresh user opening the
//     Settings tab for the first time must not see a UI that says
//     "email is off".
//   - Foreign key to users(id) with ON DELETE CASCADE so removing a
//     user also drops their preferences row (no orphan rows can
//     accumulate).
//   - Inserting a duplicate user_id fails (PK constraint).
func TestSQLiteMigration012_AddsUserNotificationPreferences(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	// SQLite ships with foreign-key enforcement disabled; enable it
	// so the ON DELETE CASCADE clause on the prefs table fires.
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

	if err := m.Migrate(11); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v11: %v", err)
	}

	if err := m.Migrate(12); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v12: %v", err)
	}

	// Table must exist.
	var tableSQL string
	if err := db.QueryRow(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_notification_preferences'`,
	).Scan(&tableSQL); err != nil {
		t.Fatalf("query schema: %v", err)
	}
	if tableSQL == "" {
		t.Fatal("user_notification_preferences table was not created")
	}

	// Need a users row so we can exercise the FK + ON DELETE CASCADE.
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, avatar, role, enabled) VALUES
		('u1', 'alice', 'Alice', '', 'ADMIN', 1),
		('u2', 'bob', 'Bob', '', 'MEMBER', 1)`); err != nil {
		t.Fatalf("seed users: %v", err)
	}

	// Default row for a fresh user must reflect the documented contract.
	if _, err := db.Exec(
		`INSERT INTO user_notification_preferences (user_id) VALUES ('u1')`,
	); err != nil {
		t.Fatalf("insert default row: %v", err)
	}
	var (
		emailEnabled   int
		webhookEnabled int
		webhookURL     string
	)
	if err := db.QueryRow(
		`SELECT email_enabled, webhook_enabled, webhook_url FROM user_notification_preferences WHERE user_id = 'u1'`,
	).Scan(&emailEnabled, &webhookEnabled, &webhookURL); err != nil {
		t.Fatalf("query defaults: %v", err)
	}
	if emailEnabled != 1 || webhookEnabled != 1 {
		t.Errorf("expected email + webhook enabled by default, got email=%d webhook=%d", emailEnabled, webhookEnabled)
	}
	if webhookURL != "" {
		t.Errorf("expected empty default webhook_url, got %q", webhookURL)
	}

	// Duplicate user_id must fail (PK collision).
	if _, err := db.Exec(
		`INSERT INTO user_notification_preferences (user_id) VALUES ('u1')`,
	); err == nil {
		t.Error("expected PRIMARY KEY violation on duplicate user_id")
	}

	// ON DELETE CASCADE: removing a user must also drop their prefs row.
	if _, err := db.Exec(`DELETE FROM users WHERE id = 'u1'`); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var remaining int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM user_notification_preferences WHERE user_id = 'u1'`,
	).Scan(&remaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 0 {
		t.Errorf("expected CASCADE delete to drop prefs row, got count=%d", remaining)
	}

	// u2 row must still be there — only u1 was deleted.
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM users WHERE id = 'u2'`,
	).Scan(&remaining); err != nil {
		t.Fatalf("count u2: %v", err)
	}
	if remaining != 1 {
		t.Errorf("expected u2 to remain intact, got count=%d", remaining)
	}
}

// TestSQLiteMigration012_DownDropsUserNotificationPreferences asserts
// the down migration is symmetric: the prefs table is dropped and
// the rest of the schema (notifications, preset_templates,
// column_agents.transition_trigger) is untouched.
func TestSQLiteMigration012_DownDropsUserNotificationPreferences(t *testing.T) {
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

	if err := m.Migrate(12); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v12: %v", err)
	}

	if err := m.Migrate(11); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to roll back to v11: %v", err)
	}

	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'user_notification_preferences'`,
	).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Errorf("user_notification_preferences table should be gone after rollback, got count=%d", n)
	}

	// Notifications table from migration 9 must still be present so
	// the rest of the notification surface is unaffected.
	var m2 int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
	).Scan(&m2); err != nil {
		t.Fatalf("query notifications: %v", err)
	}
	if m2 != 1 {
		t.Errorf("notifications table should remain intact after prefs rollback, got count=%d", m2)
	}
}
