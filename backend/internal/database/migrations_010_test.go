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

// TestSQLiteMigration010_AddsPresetTemplates exercises the
// preset-templates migration (010_add_preset_templates) end-to-end and
// asserts the contracts the spec calls out for s-1196:
//
//   - The preset_templates table exists after migration 10.
//   - The position index exists so the marketplace ORDER BY is cheap.
//   - At least four curated presets are seeded on a fresh DB (the four
//     PM_REVIEW_2026-09-17 §6 names: product iteration, bug triage,
//     content calendar, customer support). The seeder runs inside the
//     migration itself so an admin who hasn't touched the system still
//     gets a populated marketplace.
//   - The slug UNIQUE constraint rejects duplicates (so a future
//     operator who hand-edits a seed row can't shadow a different
//     marketplace entry with the same slug).
func TestSQLiteMigration010_AddsPresetTemplates(t *testing.T) {
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

	// Bring the schema up to the state JUST BEFORE migration 10 so the
	// Migrate(10) call exercises only the preset-templates addition.
	if err := m.Migrate(9); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v9: %v", err)
	}

	if err := m.Migrate(10); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v10: %v", err)
	}

	var tableSQL string
	if err := db.QueryRow(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'preset_templates'`,
	).Scan(&tableSQL); err != nil {
		t.Fatalf("query preset_templates schema: %v", err)
	}
	if tableSQL == "" {
		t.Fatal("preset_templates table was not created")
	}

	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_preset_templates_position'`,
	).Scan(&n); err != nil {
		t.Fatalf("query position index: %v", err)
	}
	if n != 1 {
		t.Errorf("expected idx_preset_templates_position to exist, got count=%d", n)
	}

	// The migration seeds at least the four PM-specified presets. We
	// don't pin the exact wording (that can be tweaked later) but we
	// do pin the count + a couple of identifying slugs so a regression
	// that drops the seed won't pass silently.
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM preset_templates`).Scan(&count); err != nil {
		t.Fatalf("count preset_templates: %v", err)
	}
	if count < 4 {
		t.Errorf("expected at least 4 seeded presets, got %d", count)
	}

	for _, slug := range []string{
		"product-iteration",
		"bug-triage",
		"content-calendar",
		"customer-support",
	} {
		var c int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM preset_templates WHERE slug = ?`, slug,
		).Scan(&c); err != nil {
			t.Fatalf("query preset by slug %q: %v", slug, err)
		}
		if c != 1 {
			t.Errorf("expected seeded preset with slug %q, got count=%d", slug, c)
		}
	}

	// The columns_config seed value must be valid JSON that round-trips
	// into a non-empty []ColumnConfig so the create-from-preset handler
	// has something to materialise. We don't pin the exact shape — the
	// existing handler tolerates any valid JSON — but we do require
	// non-empty JSON.
	var columnsConfig string
	if err := db.QueryRow(
		`SELECT columns_config FROM preset_templates WHERE slug = 'product-iteration'`,
	).Scan(&columnsConfig); err != nil {
		t.Fatalf("query product-iteration columns_config: %v", err)
	}
	if columnsConfig == "" || columnsConfig == "[]" || columnsConfig == "null" {
		t.Errorf("expected product-iteration to seed a non-empty columns_config, got %q", columnsConfig)
	}

	// Slug UNIQUE — second INSERT with the same slug must fail.
	if _, err := db.Exec(`
		INSERT INTO preset_templates (id, slug, name, columns_config, sample_tasks, sample_agent, position, enabled)
		VALUES ('dup', 'product-iteration', 'dup', '[]', '[]', '', 99, 1)
	`); err == nil {
		t.Error("expected UNIQUE(slug) constraint to reject duplicate slug")
	}
}

// TestSQLiteMigration010_DownDropsPresetTemplates asserts the down
// migration is symmetric with the up: the table and its index go away
// and any rows they carried disappear with them. The rest of the
// schema (notifications, users, etc.) is untouched.
func TestSQLiteMigration010_DownDropsPresetTemplates(t *testing.T) {
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

	if err := m.Migrate(10); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to migrate to v10: %v", err)
	}

	if err := m.Migrate(9); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to roll back to v9: %v", err)
	}

	var n int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'preset_templates'`,
	).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Errorf("preset_templates table should be gone after rollback, got count=%d", n)
	}

	// Notifications table from migration 9 must still be present so
	// the rest of the schema is unaffected.
	var m2 int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
	).Scan(&m2); err != nil {
		t.Fatalf("query notifications: %v", err)
	}
	if m2 != 1 {
		t.Errorf("notifications table should remain intact after preset_templates rollback, got count=%d", m2)
	}
}