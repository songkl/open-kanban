package database_test

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/database/migrations"
)

// TestSQLiteMigration007_AcceptsLongContent pins down the contract of
// the migration that widens comments.content from TEXT to LONGTEXT on
// MySQL (and is documentation-only on SQLite because SQLite TEXT is
// already variable-length). The kanban task s-1018 explicitly asked
// for "当前评论大小为？是否需要改为不限制长度" — the answer is that
// comment length is now unbounded at every layer (no validator max,
// MySQL column widened to LONGTEXT, SQLite TEXT already variable),
// and this test makes that contract observable at the migration level
// rather than only at the handler level.
//
// Sizes picked to bracket the documented pain points:
//
//   - 65,535 bytes : MySQL TEXT cap, the boundary the prior schema
//     used to fail on.
//   - 65,536 bytes : the first byte past the TEXT cap — exactly the
//     size that previously failed at INSERT time.
//   - 1 MiB        : comfortably inside LONGTEXT (4 GiB) territory
//     and well past anything a real comment would ever reach.
//
// On SQLite TEXT, all three sizes succeed because the column type has
// no per-type size cap. The test still runs through the full migration
// sequence (so a regression that re-introduces a CHECK constraint or
// a TRIGGER that limits length would fail here rather than at the
// handler layer).
func TestSQLiteMigration007_AcceptsLongContent(t *testing.T) {
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

	// Run every embedded migration including 007 so we are
	// exercising the post-007 schema shape.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// Seed the FK chain: users -> boards -> columns -> tasks so the
	// comments INSERT satisfies the FOREIGN KEY (task_id) REFERENCES
	// tasks(id) constraint.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u1', 'alice', 'alice', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO boards (id, name) VALUES ('b1', 'B1')
	`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO columns (id, name, board_id) VALUES ('c1', 'C1', 'b1')
	`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO tasks (id, title, column_id, published)
		VALUES ('t1', 'Task One', 'c1', 1)
	`); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	sizes := []struct {
		name string
		size int
	}{
		{"65535 bytes (MySQL TEXT cap)", 65535},
		{"65536 bytes (one over TEXT cap)", 65536},
		{"1 MiB", 1024 * 1024},
	}

	for _, tc := range sizes {
		t.Run(tc.name, func(t *testing.T) {
			commentID := "cm-" + tc.name
			content := strings.Repeat("a", tc.size)
			if _, err := db.Exec(
				"INSERT INTO comments (id, content, author, task_id, user_id) VALUES (?, ?, 'alice', 't1', 'u1')",
				commentID, content,
			); err != nil {
				t.Fatalf("insert %d-byte comment failed (s-1018 contract is that length is never a 400/500 driver error): %v",
					tc.size, err)
			}

			var stored string
			if err := db.QueryRow("SELECT content FROM comments WHERE id = ?", commentID).Scan(&stored); err != nil {
				t.Fatalf("read back: %v", err)
			}
			if len(stored) != tc.size {
				t.Errorf("round-trip length: got %d, want %d (storage truncated oversized content)",
					len(stored), tc.size)
			}
		})
	}
}

// TestSQLiteMigration007_PreservesExistingComments verifies that the
// up/down pair for migration 007 is non-destructive on SQLite:
// existing comments survive rolling back and re-applying the
// migration. On MySQL the schema change is metadata-only in 8.0+ so
// the same guarantee holds there, but the test is the cheapest place
// to lock the contract down.
func TestSQLiteMigration007_PreservesExistingComments(t *testing.T) {
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
	if _, err := db.Exec(`
		INSERT INTO boards (id, name) VALUES ('b1', 'B1')
	`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO columns (id, name, board_id) VALUES ('c1', 'C1', 'b1')
	`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO tasks (id, title, column_id, published)
		VALUES ('t1', 'Task One', 'c1', 1)
	`); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	// Seed a regular comment and an oversized one. The oversized one
	// is exactly the case that would have failed at INSERT time on
	// MySQL TEXT — after migration 007 it must survive the down/up
	// round trip.
	shortContent := "plain comment"
	longContent := strings.Repeat("x", 100*1024)

	if _, err := db.Exec(
		"INSERT INTO comments (id, content, author, task_id, user_id) VALUES ('cm-short', ?, 'alice', 't1', 'u1')",
		shortContent,
	); err != nil {
		t.Fatalf("seed short comment: %v", err)
	}
	if _, err := db.Exec(
		"INSERT INTO comments (id, content, author, task_id, user_id) VALUES ('cm-long', ?, 'alice', 't1', 'u1')",
		longContent,
	); err != nil {
		t.Fatalf("seed long comment: %v", err)
	}

	// Roll back one step (007 -> 006). The SQLite down migration is a
	// documented no-op (see sqlite/007_extend_comment_content.down.sql),
	// so this should leave both rows intact.
	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to roll back 007: %v", err)
	}

	// Re-apply 007.
	if err := m.Steps(1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to re-apply 007: %v", err)
	}

	// Both rows must still be present with their original content
	// intact.
	var gotShort, gotLong string
	if err := db.QueryRow("SELECT content FROM comments WHERE id = 'cm-short'").Scan(&gotShort); err != nil {
		t.Fatalf("read short after round-trip: %v", err)
	}
	if gotShort != shortContent {
		t.Errorf("short comment content drifted: got %q want %q", gotShort, shortContent)
	}
	if err := db.QueryRow("SELECT content FROM comments WHERE id = 'cm-long'").Scan(&gotLong); err != nil {
		t.Fatalf("read long after round-trip: %v", err)
	}
	if gotLong != longContent {
		t.Errorf("long comment content drifted: got %d bytes want %d bytes", len(gotLong), len(longContent))
	}
}
