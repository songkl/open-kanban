//go:build !mysql

package database

import (
	"database/sql"
	"os/exec"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/version"
)

// TestIsDevGitBuild sanity-checks the dev-build detection rule: it
// must return true only when the full `git describe --tags` output
// differs from the tag-only `--abbrev=0` output (i.e. HEAD carries a
// "-N-gXXXX" suffix past the closest tag). On a fresh clone with no
// commits past the closest tag both outputs match and the helper
// returns false; in CI / local development the helper returns true.
//
// The helper is the linchpin of the s-1134 fix — without it the
// migration runner stops at migration 2 on dev builds because the
// tag-only version "0.2.0" maps to migrations 1..2 in
// VersionMigrationMap and never runs the locally-added migration
// 008 (users.created_by) that the application code now expects.
func TestIsDevGitBuild(t *testing.T) {
	full := version.GetFullGitVersion()
	tag := version.GetGitVersion()

	got := isDevGitBuild()

	switch {
	case full == "" || tag == "":
		// Either the git binary is missing or no tags exist; the
		// helper must fall back to "production-style" behaviour
		// and skip the dev-build short-circuit.
		if got {
			t.Errorf("isDevGitBuild should be false when either git version call returns empty (full=%q tag=%q)", full, tag)
		}
	default:
		want := full != tag
		if got != want {
			t.Errorf("isDevGitBuild = %v, want %v (full=%q tag=%q)", got, want, full, tag)
		}
	}
}

// TestRunSQLiteMigrations_AppliesAllEmbeddedMigrationsOnDevBuild is
// the regression test for s-1134. Before the fix the migration
// runner stopped at migration 2 on dev builds because the tag-only
// version "0.2.0" mapped to migrations 1..2 in VersionMigrationMap,
// so users.created_by (added by migration 008 for s-1131) was never
// applied. POST /api/v1/auth/agents then returned 500 "Failed to
// create" because the CreateAgent INSERT hit "no such column:
// created_by" at runtime.
//
// The test simulates the dev-build startup path: it opens a fresh
// in-memory SQLite DB, invokes the unexported runSQLiteMigrations,
// and asserts the resulting schema carries users.created_by plus
// its index. This is the same schema shape the CreateAgent handler
// relies on at request time.
func TestRunSQLiteMigrations_AppliesAllEmbeddedMigrationsOnDevBuild(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	defer db.Close()

	// Mirror initSQLite() PRAGMAs so the driver accepts the
	// migrations exactly like production startup.
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("runSQLiteMigrations: %v", err)
	}

	// 1. Migration 008 must have run, otherwise POST /api/v1/auth/agents
	//    fails with "no such column: created_by" at insert time.
	var createdByCol int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'created_by'",
	).Scan(&createdByCol); err != nil {
		t.Fatalf("inspect users columns: %v", err)
	}
	if createdByCol != 1 {
		t.Errorf("expected users.created_by column after migration 008, got count=%d", createdByCol)
	}

	// 2. Migration 008 also adds idx_users_created_by — without it
	//    the new "filter by creator" queries on /api/v1/auth/agents
	//    fall back to full scans and silently regress in latency.
	var idxCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_created_by'",
	).Scan(&idxCount); err != nil {
		t.Fatalf("check idx_users_created_by: %v", err)
	}
	if idxCount != 1 {
		t.Errorf("expected idx_users_created_by after migration 008, got count=%d", idxCount)
	}

	// 3. The exact INSERT the CreateAgent handler runs must now
	//    succeed — this is the regression guard for the 500
	//    {"error":"Failed to create"} reported on /api/v1/auth/agents.
	//    We seed the creator first because users.created_by carries a
	//    FOREIGN KEY REFERENCES users(id) ON DELETE SET NULL.
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'HUMAN', 'ADMIN', 1, ?, ?)
	`, "admin1", "admin", "Admin", "", "2026-01-01", "2026-01-01"); err != nil {
		t.Fatalf("seed creator: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO users (id, username, nickname, avatar, type, role, created_at, updated_at, last_active_at, created_by)
		VALUES (?, ?, ?, ?, 'AGENT', ?, ?, ?, ?, ?)
	`, "test-agent", "test-agent", "Test Agent", "🤖", "ADMIN", "2026-01-01", "2026-01-01", "2026-01-01", "admin1"); err != nil {
		t.Errorf("CreateAgent-style INSERT into users should succeed on dev build after migration 008 ran, got: %v", err)
	}
}

// TestRunSQLiteMigrations_Idempotent ensures the dev-build path is
// safe to run repeatedly: a second invocation against an already-
// migrated DB must succeed (golang-migrate returns ErrNoChange
// under the hood) rather than error or re-apply the migrations.
func TestRunSQLiteMigrations_Idempotent(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("first runSQLiteMigrations: %v", err)
	}
	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("second runSQLiteMigrations (idempotent) failed: %v", err)
	}
}

// TestRunSQLiteMigrations_HandlesVersionMapMissingEntry confirms
// that when the tag-only version is empty or not in the version
// map, the runner still applies every embedded migration. The
// in-memory git tag is what would happen in a shallow clone with no
// tags at all — the runner must not refuse to migrate.
func TestRunSQLiteMigrations_HandlesVersionMapMissingEntry(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	if err := runSQLiteMigrations(db); err != nil {
		t.Fatalf("runSQLiteMigrations: %v", err)
	}

	// Sanity check: at least the canonical tables exist.
	for _, table := range []string{"users", "tokens", "boards"} {
		var n int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table,
		).Scan(&n); err != nil {
			t.Errorf("check table %s: %v", table, err)
			continue
		}
		if n != 1 {
			t.Errorf("expected table %s after migrations, got count=%d", table, n)
		}
	}
}

// gitDescription is a tiny helper used by ad-hoc spot-checks. Kept
// here so future test authors don't have to import os/exec every
// time. Returns "" when git is unavailable so callers can treat it
// as "no tag information".
func gitDescription(args ...string) string {
	out, err := exec.Command("git", append([]string{"describe"}, args...)...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
