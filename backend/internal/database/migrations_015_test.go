package database

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
)

// TestRunSQLiteMigrations_AllowsColumnBulkActionActivities pins
// migration 015 (s-1212): a fresh SQLite database brought up by
// runSQLiteMigrations must permit the new BULK_ARCHIVE_COLUMN /
// BULK_COMPLETE_COLUMN action types on the activities table so
// the new BulkColumnAction handler can record its audit row.
//
// We seed a row with each of the new action types and verify that
// the CHECK constraint on activities.action accepts them — which
// is the same constraint that rejects an unknown action today and
// would have been the silent failure mode for the new handler.
func TestRunSQLiteMigrations_AllowsColumnBulkActionActivities(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "kanban.db")
	t.Setenv("DB_TYPE", "sqlite")
	t.Setenv("DATABASE_URL", dbPath)

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("runSQLiteMigrations: %v", err)
	}

	// Seed the foreign keys the activities CHECK relies on so the
	// INSERTs exercise the same constraint surface the production
	// handler will hit. Other tables are not under test here —
	// only the activities.action CHECK widening.
	seed := []string{
		`INSERT INTO users (id, username, nickname) VALUES ('u1', 'admin', 'admin')`,
		`INSERT INTO boards (id, name) VALUES ('b1', 'Board')`,
		`INSERT INTO columns (id, name, board_id) VALUES ('c1', 'Column', 'b1')`,
	}
	for _, stmt := range seed {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed: %v (stmt: %s)", err, stmt)
		}
	}

	// Round-trip each new action type — if the CHECK widening
	// were missing, one of these INSERTs would fail with
	// "CHECK constraint failed: activities".
	for _, action := range []string{"BULK_ARCHIVE_COLUMN", "BULK_COMPLETE_COLUMN"} {
		_, err := db.Exec(
			`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, source) VALUES (?, 'u1', ?, 'COLUMN', 'c1', 'Column', 'bulk action', 'web')`,
			"act-"+action, action,
		)
		if err != nil {
			t.Fatalf("expected activities.action to accept %q after migration 015 (s-1212); insert failed: %v", action, err)
		}
	}

	// Sanity: the rows actually landed. If a future migration
	// widens the constraint but also purges the rows we just
	// inserted, this assertion will fail and force the test to be
	// updated alongside the new behavior.
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM activities WHERE action IN ('BULK_ARCHIVE_COLUMN', 'BULK_COMPLETE_COLUMN')`,
	).Scan(&count); err != nil {
		t.Fatalf("count activities: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 seeded activity rows, got %d", count)
	}
}

// TestRunSQLiteMigrations_015RoundTripDown exercises the down side
// of migration 015: starting from the post-up schema, running the
// down migration must drop any rows whose action is no longer
// permitted (BULK_ARCHIVE_COLUMN, BULK_COMPLETE_COLUMN) and rebuild
// the activities table with the prior CHECK list. This guards the
// symmetric contract between the up and down SQL files.
func TestRunSQLiteMigrations_015RoundTripDown(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "kanban.db")
	t.Setenv("DB_TYPE", "sqlite")
	t.Setenv("DATABASE_URL", dbPath)

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("create sqlite driver: %v", err)
	}
	src, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("create migration source: %v", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "sqlite3", driver)
	if err != nil {
		t.Fatalf("create migrate instance: %v", err)
	}

	if err := m.Migrate(15); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up to 15: %v", err)
	}

	// Seed an activity row under the widened CHECK so we have
	// something the down migration must drop.
	if _, err := db.Exec(`INSERT INTO users (id, username, nickname) VALUES ('u1', 'admin', 'admin')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO activities (id, user_id, action, target_type, source) VALUES ('a1', 'u1', 'BULK_ARCHIVE_COLUMN', 'COLUMN', 'web')`); err != nil {
		t.Fatalf("seed activity: %v", err)
	}

	if err := m.Migrate(14); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate down to 14: %v", err)
	}

	var remaining int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM activities WHERE action IN ('BULK_ARCHIVE_COLUMN', 'BULK_COMPLETE_COLUMN')`,
	).Scan(&remaining); err != nil {
		t.Fatalf("count post-down: %v", err)
	}
	if remaining != 0 {
		t.Errorf("expected down migration to drop BULK_* activity rows; %d remain", remaining)
	}
}
