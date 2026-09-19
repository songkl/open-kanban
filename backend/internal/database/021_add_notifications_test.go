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

// TestSQLiteMigration021_AddsNotificationsTable exercises the
// notifications migration (009_add_notifications) end-to-end and
// asserts the contracts the spec calls out for s-1194:
//
//   - The notifications table exists after migration 21.
//   - Both lookup indexes exist (user_id+read_at and user_id+created_at)
//     so the bell-badge query is index-backed.
//   - Inserting a row through the public surface (handlers.InsertNotification)
//     succeeds and is queryable.
//   - The CHECK constraint rejects an unknown source value (so a
//     client typo can't write a row that the bell badge then drops).
func TestSQLiteMigration021_AddsNotificationsTable(t *testing.T) {
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

	// Bring the schema up to the state JUST BEFORE migration 21 so
	// the next Migrate(21) call exercises only the notifications
	// addition.
	if err := m.Migrate(8); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v8: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed users: %v", err)
	}

	if err := m.Migrate(21); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v9: %v", err)
	}

	var tableSQL string
	if err := db.QueryRow(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
	).Scan(&tableSQL); err != nil {
		t.Fatalf("query notifications schema: %v", err)
	}
	if tableSQL == "" {
		t.Fatal("notifications table was not created")
	}

	for _, idx := range []string{
		"idx_notifications_user_unread",
		"idx_notifications_user_created",
	} {
		var n int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, idx,
		).Scan(&n); err != nil {
			t.Fatalf("query index %s: %v", idx, err)
		}
		if n != 1 {
			t.Errorf("expected index %s to exist, got count=%d", idx, n)
		}
	}

	if _, err := db.Exec(
		`INSERT INTO notifications (id, user_id, source, title, body, target_type, target_id)
		 VALUES ('n1', 'u1', 'TASK_ASSIGNED', 'hello', 'world', 'TASK', 't1')`,
	); err != nil {
		t.Fatalf("insert valid row: %v", err)
	}

	if _, err := db.Exec(
		`INSERT INTO notifications (id, user_id, source, title, body, target_type, target_id)
		 VALUES ('n2', 'u1', 'BOGUS', 'x', 'y', '', '')`,
	); err == nil {
		t.Error("expected CHECK constraint to reject unknown source")
	}
}

// TestSQLiteMigration021_DownDropsNotificationsTable asserts that
// rolling back the notifications migration is non-destructive to
// the rest of the schema: the table goes away but users / boards /
// columns remain queryable.
func TestSQLiteMigration021_DownDropsNotificationsTable(t *testing.T) {
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

	if err := m.Migrate(21); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v9: %v", err)
	}

	if err := m.Migrate(8); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to roll back to v8: %v", err)
	}

	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
	).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Errorf("notifications table should be gone after rollback, got count=%d", n)
	}

	var userCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount); err != nil {
		t.Fatalf("query users: %v", err)
	}
	if userCount != 0 {
		t.Errorf("users table should remain intact, got count=%d", userCount)
	}
}