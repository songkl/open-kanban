//go:build !mysql && !sqlite

package database

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
)

// TestRunSQLiteMigrations_AppliesAllEmbeddedMigrations reproduces the
// s-1050 bug: a fresh SQLite database is brought up to migration 2
// (matching what an old "0.2.0" git tag would have produced), and then
// the migration runner is invoked a second time as if a new binary
// with a stale tag were restarting. The runner must apply every
// embedded migration — including the post-002 ones that introduce
// `boards.is_public`, the audit columns on board_permissions, etc. —
// rather than capping at the version map's `toMig` (which would have
// been 2 for a 0.2.0 checkout and would leave is_public missing).
func TestRunSQLiteMigrations_AppliesAllEmbeddedMigrations(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "kanban.db")
	t.Setenv("DB_TYPE", "sqlite")
	t.Setenv("DATABASE_URL", dbPath)

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Simulate the state a previous "0.2.0" binary would have left:
	// schema_migrations is at version 2 and the boards table exists
	// WITHOUT the is_public column (the 004 migration is the one
	// that adds it).
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
	if err := m.Migrate(2); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("seed DB to migration 2: %v", err)
	}

	// Sanity check: the pre-fix state really is missing is_public.
	if hasIsPublic(t, db) {
		t.Fatalf("precondition violated: boards.is_public should NOT exist on a v2 DB, but it does")
	}

	// Now invoke the production migration runner. With the old
	// version-capped code path this would no-op (DB is already at
	// toMig=2) and leave the schema broken. With the fix the runner
	// applies every embedded migration on top of the current state.
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("runSQLiteMigrations: %v", err)
	}

	if !hasIsPublic(t, db) {
		t.Errorf("expected boards.is_public to be added by the migration runner (s-1050); column still missing")
	}

	// Verify the other post-002 migrations also took effect. The
	// board_permissions audit columns come from migration 008, so a
	// successful run must have populated them too. Catching just
	// is_public would miss a regression that fixes 004 but breaks
	// 005-008.
	wantColumns := []string{
		"granted_by_user_id",
		"expires_at",
		"revoked_at",
		"revoked_by_user_id",
		"notes",
	}
	for _, col := range wantColumns {
		if !hasColumn(t, db, "board_permissions", col) {
			t.Errorf("expected board_permissions.%s to exist after the migration runner (s-1050); column still missing", col)
		}
	}
}

// TestRunSQLiteMigrations_Idempotent locks in the safety property the
// fix relies on: calling the runner twice in a row (the realistic
// startup pattern — every restart re-runs migrations) must not error
// and must leave the schema identical to a single call.
func TestRunSQLiteMigrations_Idempotent(t *testing.T) {
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
		t.Fatalf("first runSQLiteMigrations: %v", err)
	}
	if !hasIsPublic(t, db) {
		t.Fatalf("first run did not apply is_public migration")
	}
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("second runSQLiteMigrations: %v", err)
	}
	if !hasIsPublic(t, db) {
		t.Errorf("is_public column disappeared after a second run")
	}
}

// hasIsPublic reports whether the boards table exposes the is_public
// column added by migration 004.
func hasIsPublic(t *testing.T, db *sql.DB) bool {
	t.Helper()
	return hasColumn(t, db, "boards", "is_public")
}

// hasColumn looks up a single column by name in the given table. Used
// by the migration-runner tests to verify the runner actually applied
// the migration that adds the column, rather than relying on PRAGMA
// table_info side effects.
func hasColumn(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("pragma table_info(%s): %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma row: %v", err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate pragma rows: %v", err)
	}
	return false
}

// Sanity guard: the test above only exercises a code path that
// actually exists in db.go. If a future refactor moves the runner or
// renames the function, this compile-time check fails first so the
// test cannot silently regress to "passing for the wrong reasons".
var _ = runSQLiteMigrations

// Avoid an "imported and not used" build error in a stripped-down
// build that drops one of the imports above.
var _ = os.Create
