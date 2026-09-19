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

// TestRunSQLiteMigrations_RecoversFromDrift reproduces the s-1217
// production incident: kanban.db is left in a state where
// schema_migrations.version is set to the latest migration but the
// actual schema is missing one of the post-004 columns (the symptom
// the operator reported was /api/v1/boards returning 500 because
// the boards.is_public column was missing). m.Up() is a no-op
// when the recorded version already covers the embedded migrations,
// so the runner needs an explicit drift check that rewinds the
// recorded version to the highest canary that actually applied
// (or NilVersion when every canary is missing) and lets m.Up()
// replay only the missing migrations.
//
// Seed:
//   - Bring the DB up to the latest migration normally.
//   - Drop boards.is_public (migration 004) and tasks.due_at
//     (migration 014) — the two ALTER TABLE ADD COLUMN steps
//     that are not naturally idempotent, mirroring the production
//     drift state.
//   - Call runSQLiteMigrations a second time.
//
// Expected:
//   - The drift check fires.
//   - The recorded version is rewound to NilVersion (effective=0).
//   - m.Up() re-applies every embedded migration.
//   - boards.is_public, tasks.due_at, and the post-008 audit
//     columns are all restored.
func TestRunSQLiteMigrations_RecoversFromDrift(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "kanban.db")
	t.Setenv("DB_TYPE", "sqlite")
	t.Setenv("DATABASE_URL", dbPath)

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// First pass: bring the DB up to the latest migration. After
	// this the boards table has is_public and every post-004
	// schema element is in place.
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("first runSQLiteMigrations: %v", err)
	}
	if !hasIsPublic(t, db) {
		t.Fatalf("precondition: boards.is_public missing after first run")
	}

	// Simulate the s-1217 drift state: drop the is_public column
	// the schema_migrations table still claims was applied by
	// migration 004. SQLite's ALTER TABLE doesn't support DROP
	// COLUMN on older builds, so rebuild the table without
	// is_public via the same create/copy/drop/rename dance the
	// migration itself uses.
	driftSimulateDropIsPublic(t, db)

	if hasIsPublic(t, db) {
		t.Fatalf("drift precondition: is_public should be gone after drop")
	}

	// Drop tasks.due_at for the same reason — migration 014 also
	// uses ALTER TABLE ADD COLUMN, so a real drift event leaves
	// both missing. Without this the runner would correctly
	// re-apply migration 004 only and skip 014, and the test
	// would silently pass even though the production drift case
	// (both columns missing) is more interesting.
	driftSimulateDropDueAt(t, db)

	if hasColumn(t, db, "tasks", "due_at") {
		t.Fatalf("drift precondition: tasks.due_at should be gone after drop")
	}

	// Second pass: this is the restart that triggers the drift
	// repair. The runner must detect the mismatch and force a
	// re-run rather than silently leaving the schema broken.
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("second runSQLiteMigrations (drift repair): %v", err)
	}

	if !hasIsPublic(t, db) {
		// Diagnostic dump so a future failure doesn't have to be
		// reproduced by hand.
		dumpBoardsSchema(t, db)
		dumpSchemaMigrations(t, db)
		t.Errorf("drift repair failed: boards.is_public still missing after re-running migrations")
	}

	// The other post-004 audit columns must also be present —
	// the drift repair re-applies every migration, not just 004.
	for _, col := range []string{
		"granted_by_user_id",
		"expires_at",
		"revoked_at",
		"revoked_by_user_id",
		"notes",
	} {
		if !hasColumn(t, db, "board_permissions", col) {
			t.Errorf("drift repair did not restore board_permissions.%s", col)
		}
	}
	if !hasColumn(t, db, "tasks", "due_at") {
		t.Errorf("drift repair did not restore tasks.due_at")
	}
}

// dumpBoardsSchema prints the columns of the boards table. Used as
// a diagnostic helper inside TestRunSQLiteMigrations_RecoversFromDrift
// so a future regression surfaces a useful error message instead of
// just "column still missing".
func dumpBoardsSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(boards)")
	if err != nil {
		t.Logf("dumpBoardsSchema: pragma failed: %v", err)
		return
	}
	defer rows.Close()
	t.Log("boards schema after drift repair:")
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Logf("  scan failed: %v", err)
			continue
		}
		t.Logf("  cid=%d name=%s type=%s", cid, name, ctype)
	}
}

// dumpSchemaMigrations prints the recorded schema_migrations row so
// a future regression in the drift-repair path can be diagnosed from
// the test log alone.
func dumpSchemaMigrations(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query("SELECT version, dirty FROM schema_migrations")
	if err != nil {
		t.Logf("dumpSchemaMigrations: select failed: %v", err)
		return
	}
	defer rows.Close()
	t.Log("schema_migrations rows after drift repair:")
	for rows.Next() {
		var version int
		var dirty bool
		if err := rows.Scan(&version, &dirty); err != nil {
			t.Logf("  scan failed: %v", err)
			continue
		}
		t.Logf("  version=%d dirty=%v", version, dirty)
	}
}

// TestSQLiteSchemaDrift_NoFalsePositiveOnFreshDB locks in the
// safety property the drift detection relies on: on a fresh DB
// (no schema_migrations table yet), the function must report
// "no drift" so the runner still applies migrations normally
// instead of short-circuiting with a forced reset that would
// confuse operators looking at the logs.
func TestSQLiteSchemaDrift_NoFalsePositiveOnFreshDB(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "fresh.db")

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	drift, err := sqliteSchemaDrift(db)
	if err != nil {
		t.Fatalf("sqliteSchemaDrift on fresh DB: %v", err)
	}
	if drift {
		t.Errorf("expected no drift on a fresh DB (no schema_migrations yet); drift=true would force an unnecessary reset")
	}
}

// TestSQLiteSchemaDrift_DetectsMissingColumn covers the unit-level
// guarantee: when the recorded schema_migrations.version is >= 4
// but the boards table is missing is_public, the helper reports
// drift=true (the runner should force a reset).
func TestSQLiteSchemaDrift_DetectsMissingColumn(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "drift.db")

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Bring the DB up to the latest migration so the boards table
	// and schema_migrations are both present.
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("seed runSQLiteMigrations: %v", err)
	}

	// Sanity: schema_migrations.version >= 4 and is_public exists,
	// so drift should be false.
	drift, err := sqliteSchemaDrift(db)
	if err != nil {
		t.Fatalf("sqliteSchemaDrift on healthy DB: %v", err)
	}
	if drift {
		t.Fatalf("expected no drift on a healthy post-migration DB")
	}

	// Drop is_public and confirm the helper now reports drift=true.
	driftSimulateDropIsPublic(t, db)
	drift, err = sqliteSchemaDrift(db)
	if err != nil {
		t.Fatalf("sqliteSchemaDrift on drifted DB: %v", err)
	}
	if !drift {
		t.Errorf("expected drift=true after dropping is_public; got false")
	}
}

// driftSimulateDropIsPublic rebuilds the boards table without the
// is_public column to mirror the s-1217 production drift state.
// SQLite does not support DROP COLUMN on the build of go-sqlite3
// the project links, so the helper uses the same create/copy/drop
// /rename dance the migration uses for its own table rebuilds.
func driftSimulateDropIsPublic(t *testing.T, db *sql.DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE boards_new (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			short_alias TEXT UNIQUE,
			task_counter INTEGER DEFAULT 1000,
			deleted BOOLEAN DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			description TEXT DEFAULT ''
		)`,
		`INSERT INTO boards_new (id, name, short_alias, task_counter, deleted, created_at, updated_at, description)
		 SELECT id, name, short_alias, task_counter, deleted, created_at, updated_at, description FROM boards`,
		`DROP TABLE boards`,
		`ALTER TABLE boards_new RENAME TO boards`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("driftSimulateDropIsPublic step %q: %v", stmt, err)
		}
	}
}

// driftSimulateDropDueAt rebuilds the tasks table without the
// due_at column added by migration 014. Mirrors the
// driftSimulateDropIsPublic helper but for the tasks table; the
// shape is trimmed to the columns the original 001_initial_schema
// declared so the rebuild matches what a "pre-014" DB looked like.
func driftSimulateDropDueAt(t *testing.T, db *sql.DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE tasks_new (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT,
			priority TEXT DEFAULT 'medium',
			assignee TEXT,
			agent_id TEXT,
			agent_prompt TEXT,
			meta TEXT,
			column_id TEXT NOT NULL,
			position INTEGER DEFAULT 0,
			published BOOLEAN DEFAULT 0,
			archived BOOLEAN DEFAULT 0,
			archived_at DATETIME,
			created_by TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
		)`,
		`INSERT INTO tasks_new (id, title, description, priority, assignee, agent_id, agent_prompt, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at)
		 SELECT id, title, description, priority, assignee, agent_id, agent_prompt, meta, column_id, position, published, archived, archived_at, created_by, created_at, updated_at FROM tasks`,
		`DROP TABLE tasks`,
		`ALTER TABLE tasks_new RENAME TO tasks`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("driftSimulateDropDueAt step %q: %v", stmt, err)
		}
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
