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

// TestRunSQLiteMigrations_AddsFrontendEvents pins migration 016
// (s-1210, PM_REVIEW_2026-09-17 §7): a fresh SQLite database
// brought up by runSQLiteMigrations must surface the
// `frontend_events` table plus its three indexes so the
// Sentry-compatible ingest endpoint can persist unhandled
// exceptions from the React tree / window.onerror /
// unhandledrejection.
func TestRunSQLiteMigrations_AddsFrontendEvents(t *testing.T) {
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

	if !hasFrontendEventsTable(t, db) {
		t.Fatalf("expected frontend_events table to exist after running migrations (s-1210); table still missing")
	}

	// Round-trip: insert a row that exercises every column the
	// IngestFrontendEvent handler writes, then read it back to
	// confirm the schema lines up with the contract.
	_, err = db.Exec(
		`INSERT INTO frontend_events
		    (id, user_id, event_type, message, stack, url, source, details)
		 VALUES (?, NULL, 'error', ?, ?, ?, ?, ?)`,
		"e1",
		"boom",
		"Error: boom\n  at foo (bar.js:1:1)",
		"http://localhost/board/gbk",
		"bar.js:1:1",
		`{"componentStack":"at foo"}`,
	)
	if err != nil {
		t.Fatalf("insert row: %v", err)
	}

	var (
		eventType, message string
		userID             sql.NullString
	)
	if err := db.QueryRow(
		`SELECT user_id, event_type, message FROM frontend_events WHERE id = 'e1'`,
	).Scan(&userID, &eventType, &message); err != nil {
		t.Fatalf("scan row: %v", err)
	}
	if userID.Valid {
		t.Errorf("expected user_id to remain NULL for pre-login events, got %q", userID.String)
	}
	if eventType != "error" {
		t.Errorf("expected event_type 'error', got %q", eventType)
	}
	if message != "boom" {
		t.Errorf("expected message 'boom', got %q", message)
	}

	for _, idx := range []string{
		"idx_frontend_events_user_id",
		"idx_frontend_events_received_at",
		"idx_frontend_events_event_type",
	} {
		if !hasFrontendEventsIndex(t, db, idx) {
			t.Errorf("expected index %s to exist after running migrations (s-1210); index still missing", idx)
		}
	}
}

// TestRunSQLiteMigrations_016RoundTripDown exercises the down
// side of migration 016: starting from the post-up schema,
// running the down migration must drop every index and the
// frontend_events table itself. Guards against an
// up/down drift that would leave orphan indexes on MySQL.
func TestRunSQLiteMigrations_016RoundTripDown(t *testing.T) {
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

	if err := m.Migrate(28); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up to 28: %v", err)
	}
	if !hasFrontendEventsTable(t, db) {
		t.Fatalf("precondition violated: frontend_events should exist after migration 28 up")
	}

	if err := m.Migrate(15); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate down to 15: %v", err)
	}
	if hasFrontendEventsTable(t, db) {
		t.Errorf("expected frontend_events table to be dropped by the down migration; table still present")
	}
	for _, idx := range []string{
		"idx_frontend_events_user_id",
		"idx_frontend_events_received_at",
		"idx_frontend_events_event_type",
	} {
		if hasFrontendEventsIndex(t, db, idx) {
			t.Errorf("expected index %s to be dropped by the down migration; index still present", idx)
		}
	}
}

func hasFrontendEventsTable(t *testing.T, db *sql.DB) bool {
	t.Helper()
	var name string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'frontend_events'`,
	).Scan(&name)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		t.Fatalf("check table: %v", err)
	}
	return name == "frontend_events"
}

func hasFrontendEventsIndex(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var got string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
		name,
	).Scan(&got)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		t.Fatalf("check index: %v", err)
	}
	return got == name
}
