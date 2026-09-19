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

// TestSQLiteMigration020_PreservesRowCount exercises the audit-columns
// migration (008_add_permission_audit_fields) end-to-end and asserts
// the contract the spec calls out for s-1037:
//
//   - row count is unchanged (board_permissions + column_permissions)
//   - the new audit columns on existing rows are NULL / '' (no data
//     is fabricated for the new columns)
//
// The test runs migrations 1..7 first, seeds a few board_permissions
// and column_permissions rows, then runs migration 20 and verifies the
// row counts and the audit column defaults.
func TestSQLiteMigration020_PreservesRowCount(t *testing.T) {
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

	// Bring the schema up to the state JUST BEFORE migration 20 so
	// the next Migrate(20) call exercises only the audit-columns
	// addition. Migrations 1..7 are the prior baseline; migration
	// 20 is the one we want to assert on.
	if err := m.Migrate(7); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v7: %v", err)
	}

	// Seed the FK chain so the permission rows can be inserted
	// without violating the existing FK constraints from migration
	// 1 (board_permissions.user_id / board_id and column_permissions'
	// corresponding FKs).
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES
			('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1),
			('u2', 'bob',   'bob',   'HUMAN', 'MEMBER', 1),
			('u3', 'carol', 'carol', 'HUMAN', 'MEMBER', 1),
			('u4', 'dan',   'dan',   'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO boards (id, name) VALUES ('b1', 'Board One')
	`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO columns (id, name, board_id) VALUES
			('c1', 'Col One', 'b1'),
			('c2', 'Col Two', 'b1')
	`); err != nil {
		t.Fatalf("seed columns: %v", err)
	}

	// Seed 3 board_permissions rows: one owner, one ADMIN, one READ.
	// This matches the realistic shape an upgraded database would
	// carry: a creator with owner_agent_id set, plus a couple of
	// explicit grants.
	if _, err := db.Exec(`
		INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access) VALUES
			('bp-owner', 'u1', 'b1', 'u1', 'ADMIN'),
			('bp-admin', 'u2', 'b1', NULL, 'ADMIN'),
			('bp-read',  'u3', 'b1', NULL, 'READ')
	`); err != nil {
		t.Fatalf("seed board_permissions: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO column_permissions (id, user_id, column_id, access) VALUES
			('cp-c1-write', 'u2', 'c1', 'WRITE'),
			('cp-c2-read',  'u2', 'c2', 'READ')
	`); err != nil {
		t.Fatalf("seed column_permissions: %v", err)
	}

	// Capture row counts BEFORE running migration 20.
	var bpCountBefore, cpCountBefore int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&bpCountBefore); err != nil {
		t.Fatalf("count board_permissions before: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM column_permissions`).Scan(&cpCountBefore); err != nil {
		t.Fatalf("count column_permissions before: %v", err)
	}

	// Apply migration 20: this is the one that adds
	// granted_by_user_id / expires_at / revoked_at /
	// revoked_by_user_id / notes (board_permissions only).
	if err := m.Migrate(20); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v8: %v", err)
	}

	// Row counts must be identical: migration 20 is supposed to be
	// non-destructive. The SQLite path rebuilds the tables via
	// CREATE _new + INSERT-SELECT + RENAME so this is the explicit
	// guarantee the spec calls out.
	var bpCountAfter, cpCountAfter int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&bpCountAfter); err != nil {
		t.Fatalf("count board_permissions after: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM column_permissions`).Scan(&cpCountAfter); err != nil {
		t.Fatalf("count column_permissions after: %v", err)
	}
	if bpCountBefore != bpCountAfter {
		t.Errorf("board_permissions row count changed: before=%d after=%d (migration must be lossless)",
			bpCountBefore, bpCountAfter)
	}
	if cpCountBefore != cpCountAfter {
		t.Errorf("column_permissions row count changed: before=%d after=%d (migration must be lossless)",
			cpCountBefore, cpCountAfter)
	}

	// The audit columns must be NULL on the backfilled rows: the
	// spec is explicit that "所有现有 row backfill 时
	// granted_by_user_id=NULL, expires_at=NULL, revoked_at=NULL".
	// We don't fabricate historical actors out of thin air.
	rows, err := db.Query(`
		SELECT id, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes
		FROM board_permissions
		ORDER BY id
	`)
	if err != nil {
		t.Fatalf("read board_permissions: %v", err)
	}
	for rows.Next() {
		var (
			id                       string
			grantedBy, expiresAt     sql.NullString
			revokedAt, revokedBy     sql.NullString
			notes                    string
		)
		if err := rows.Scan(&id, &grantedBy, &expiresAt, &revokedAt, &revokedBy, &notes); err != nil {
			rows.Close()
			t.Fatalf("scan board_permissions: %v", err)
		}
		if grantedBy.Valid {
			t.Errorf("board_permissions.%s granted_by_user_id should be NULL on backfilled rows, got %q",
				id, grantedBy.String)
		}
		if expiresAt.Valid {
			t.Errorf("board_permissions.%s expires_at should be NULL on backfilled rows, got %q",
				id, expiresAt.String)
		}
		if revokedAt.Valid {
			t.Errorf("board_permissions.%s revoked_at should be NULL on backfilled rows, got %q",
				id, revokedAt.String)
		}
		if revokedBy.Valid {
			t.Errorf("board_permissions.%s revoked_by_user_id should be NULL on backfilled rows, got %q",
				id, revokedBy.String)
		}
		// notes is TEXT DEFAULT '' on board_permissions only; check
		// the empty-string default applies to backfilled rows.
		if notes != "" {
			t.Errorf("board_permissions.%s notes should default to '' on backfilled rows, got %q",
				id, notes)
		}
	}
	rows.Close()

	rows, err = db.Query(`
		SELECT id, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id
		FROM column_permissions
		ORDER BY id
	`)
	if err != nil {
		t.Fatalf("read column_permissions: %v", err)
	}
	for rows.Next() {
		var (
			id                       string
			grantedBy, expiresAt     sql.NullString
			revokedAt, revokedBy     sql.NullString
		)
		if err := rows.Scan(&id, &grantedBy, &expiresAt, &revokedAt, &revokedBy); err != nil {
			rows.Close()
			t.Fatalf("scan column_permissions: %v", err)
		}
		if grantedBy.Valid || expiresAt.Valid || revokedAt.Valid || revokedBy.Valid {
			t.Errorf("column_permissions.%s audit columns must be NULL on backfilled rows, got "+
				"granted_by=%v expires=%v revoked_at=%v revoked_by=%v",
				id, grantedBy, expiresAt, revokedAt, revokedBy)
		}
	}
	rows.Close()

	// The migration also creates an index on each table's revoked_at
	// column. Pin that down so a future migration that forgets to
	// recreate the index after the table rebuild fails here rather
	// than at runtime.
	wantIndexes := []string{
		"idx_board_permissions_revoked",
		"idx_column_permissions_revoked",
	}
	for _, idx := range wantIndexes {
		var n int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx,
		).Scan(&n); err != nil {
			t.Errorf("check index %s: %v", idx, err)
			continue
		}
		if n == 0 {
			t.Errorf("expected index %s to exist after migration 20", idx)
		}
	}
}

// TestSQLiteMigration020_RoundTripDown verifies the down migration
// drops the audit columns AND restores the pre-008 row count. The
// contract is that an operator can roll back without losing data
// rows (only the audit metadata is destroyed).
func TestSQLiteMigration020_RoundTripDown(t *testing.T) {
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
		t.Fatalf("failed to run migrations up: %v", err)
	}

	// Seed minimal FK chain + 2 rows each.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1),
		       ('u2', 'bob',   'bob',   'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO boards (id, name) VALUES ('b1', 'B1')`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO columns (id, name, board_id) VALUES ('c1', 'C1', 'b1')`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO board_permissions (id, user_id, board_id, access, granted_by_user_id, notes) VALUES
			('bp1', 'u1', 'b1', 'ADMIN', 'u1', 'creator'),
			('bp2', 'u2', 'b1', 'READ',  'u1', '')
	`); err != nil {
		t.Fatalf("seed board_permissions: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO column_permissions (id, user_id, column_id, access) VALUES
			('cp1', 'u1', 'c1', 'READ'),
			('cp2', 'u2', 'c1', 'WRITE')
	`); err != nil {
		t.Fatalf("seed column_permissions: %v", err)
	}

	var bpBefore, cpBefore int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&bpBefore); err != nil {
		t.Fatalf("count bp before: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM column_permissions`).Scan(&cpBefore); err != nil {
		t.Fatalf("count cp before: %v", err)
	}

	// Roll back one step (008 -> 007). The down migration rebuilds
	// the tables back to the pre-008 shape, which must keep the row
	// count unchanged. The audit metadata IS lost on rollback —
	// that's the documented lossy contract.
	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to roll back 008: %v", err)
	}

	var bpAfter, cpAfter int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&bpAfter); err != nil {
		t.Fatalf("count bp after: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM column_permissions`).Scan(&cpAfter); err != nil {
		t.Fatalf("count cp after: %v", err)
	}
	if bpBefore != bpAfter {
		t.Errorf("down migration lost board_permissions rows: before=%d after=%d",
			bpBefore, bpAfter)
	}
	if cpBefore != cpAfter {
		t.Errorf("down migration lost column_permissions rows: before=%d after=%d",
			cpBefore, cpAfter)
	}
}
