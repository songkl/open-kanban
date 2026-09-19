package database

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
)

// TestRunSQLiteMigrations_AddsDueAtColumn pins migration 014
// (T-1207 / s-1207, PM_REVIEW_2026-09-17 §3.12): a fresh SQLite
// database brought up by runSQLiteMigrations must surface
// tasks.due_at + idx_tasks_due_at so the create-task modal can
// persist a deadline without falling back to a free-text meta
// key.
func TestRunSQLiteMigrations_AddsDueAtColumn(t *testing.T) {
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

	if !hasColumn(t, db, "tasks", "due_at") {
		t.Errorf("expected tasks.due_at to exist after running migrations (T-1207 / s-1207); column still missing")
	}

	// Round-trip: the column must be writable and NULL-able.
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id, due_at) VALUES ('t1', 'Test', 'c1', '2026-12-31 08:00:00')`); err != nil {
		t.Fatalf("insert with due_at: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tasks (id, title, column_id) VALUES ('t2', 'NoDue', 'c1')`); err != nil {
		t.Fatalf("insert without due_at: %v", err)
	}

	var dueAt sql.NullString
	if err := db.QueryRow(`SELECT due_at FROM tasks WHERE id = 't1'`).Scan(&dueAt); err != nil {
		t.Fatalf("query due_at: %v", err)
	}
	if !dueAt.Valid {
		t.Errorf("expected due_at round-trip to keep the timestamp, got NULL")
	}
	// SQLite normalizes the DATETIME on the way out, so accept
	// either the ISO or the space-separated form — what we are
	// pinning down is "the column survived and a non-null value
	// came back".
	if !strings.HasPrefix(dueAt.String, "2026-12-31") {
		t.Errorf("expected due_at to keep the date prefix '2026-12-31', got %q", dueAt.String)
	}
	if err := db.QueryRow(`SELECT due_at FROM tasks WHERE id = 't2'`).Scan(&dueAt); err != nil {
		t.Fatalf("query due_at for null row: %v", err)
	}
	if dueAt.Valid {
		t.Errorf("expected due_at to be NULL when omitted, got %q", dueAt.String)
	}

	// idx_tasks_due_at is what makes the upcoming "due in next N
	// days" surface cheap. Make sure the index actually exists so
	// a future migration that drops the index intentionally has
	// to update this assertion as a guardrail.
	if !hasIndex(t, db, "idx_tasks_due_at") {
		t.Errorf("expected idx_tasks_due_at to exist after running migrations (T-1207 / s-1207); index still missing")
	}
}

// TestRunSQLiteMigrations_014RoundTripDown exercises the down side
// of migration 014: starting from the post-up schema, running the
// down migration must drop the index and the due_at column. This
// guards against the symlink between the index and the column being
// broken (e.g. dropping the column while the index still references
// it would fail on MySQL).
func TestRunSQLiteMigrations_014RoundTripDown(t *testing.T) {
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

	// Bring the DB to the head, then step back to 13.
	if err := m.Migrate(14); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up to 14: %v", err)
	}
	if !hasColumn(t, db, "tasks", "due_at") {
		t.Fatalf("precondition violated: tasks.due_at should exist after migration 14 up, but it does not")
	}
	if err := m.Migrate(13); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate down to 13: %v", err)
	}
	if hasColumn(t, db, "tasks", "due_at") {
		t.Errorf("expected tasks.due_at to be dropped by the down migration; column still present")
	}
	if hasIndex(t, db, "idx_tasks_due_at") {
		t.Errorf("expected idx_tasks_due_at to be dropped by the down migration; index still present")
	}
}

// hasIndex reports whether a named SQLite index exists in the
// database. Used to lock in the idx_tasks_due_at index that
// migration 014 introduces — a future maintainer who drops the
// index intentionally has to update this helper as a guardrail.
func hasIndex(t *testing.T, db *sql.DB, indexName string) bool {
	t.Helper()
	rows, err := db.Query("PRAGMA index_list(tasks)")
	if err != nil {
		t.Fatalf("pragma index_list: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			seq     int
			name    string
			unique  int
			origin  string
			partial int
		)
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			t.Fatalf("scan pragma row: %v", err)
		}
		if name == indexName {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate pragma rows: %v", err)
	}
	return false
}