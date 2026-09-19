package database

import (
	"database/sql"
	"strings"
)

// sqliteSchemaDrift reports whether the recorded schema_migrations
// version is out of sync with the actual schema. It returns true
// when the recorded version claims migration 4 (boards.is_public)
// or later was applied but the column is missing — meaning the
// recorded version is untrustworthy and the runner should force a
// reset before calling m.Up(). On a fresh DB the schema_migrations
// table does not exist yet; that case is treated as "no drift" so
// the runner still applies the migrations normally.
//
// This check is intentionally narrow (one column). The full set of
// post-004 schema elements is covered indirectly: every later
// migration depends on the 001 base tables and 004 is the first
// schema change to a base table, so a drift in 004 implies a drift
// in every subsequent migration that also touches a base table.
func sqliteSchemaDrift(db *sql.DB) (bool, error) {
	recorded, err := sqliteRecordedMigrationVersion(db)
	if err != nil {
		return false, err
	}
	if recorded < 4 {
		return false, nil
	}
	has, err := sqliteTableHasColumn(db, "boards", "is_public")
	if err != nil {
		return false, err
	}
	return !has, nil
}

// sqliteEffectiveMigrationVersion inspects the actual schema and
// returns the highest migration version that has been applied —
// regardless of what schema_migrations.version says. This is used
// to recover from the s-1217 drift state where the recorded
// version is ahead of the actual schema and m.Up() refuses to
// re-apply anything.
//
// Each migration is mapped to a single canary schema element (a
// table or column) that did not exist before that migration ran.
// The effective version is the highest canary version V such that
// every canary from migration 4 through V is present — this
// preserves the monotonicity assumption (migrations are applied
// in order) so a "canary missing below V" case rewinds all the
// way to just before the gap, instead of trying to re-run past
// migrations that are already applied and would fail with
// "duplicate column" from the ALTER TABLE ADD COLUMN steps in
// migrations 004 and 014.
//
// When the schema is fresh (no canary is present) the returned
// version is 0. The runner treats 0 as "force NilVersion" so
// m.Up() starts from the first embedded migration.
func sqliteEffectiveMigrationVersion(db *sql.DB) (int, error) {
	// Canary definitions. Each entry must point to a schema
	// element that the named migration is the FIRST to introduce —
	// checking later migrations' elements would let a partially
	// applied state look fully applied and skip the repair.
	canaries := []struct {
		version int
		table   string
		column  string // empty means "table itself is the canary"
	}{
		{4, "boards", "is_public"},                          // 004
		{9, "notifications", ""},                           // 009 (table)
		{10, "preset_templates", ""},                       // 010 (table)
		{11, "column_agents", "transition_trigger"},        // 011
		{12, "user_notification_preferences", ""},          // 012 (table)
		{13, "viewer_tokens", ""},                          // 013 (table)
		{14, "tasks", "due_at"},                             // 014
		{16, "frontend_events", ""},                        // 016 (table)
	}

	// Walk from the lowest canary up. The effective version is the
	// last canary whose canary is present, BUT only as long as every
	// preceding canary is also present. The moment we hit a missing
	// canary the monotonicity assumption breaks and we rewind to
	// just before that gap.
	highest := 0
	for _, c := range canaries {
		var present bool
		var err error
		if c.column == "" {
			present, err = sqliteTableExists(db, c.table)
		} else {
			present, err = sqliteTableHasColumn(db, c.table, c.column)
		}
		if err != nil {
			return 0, err
		}
		if !present {
			break
		}
		highest = c.version
	}
	return highest, nil
}

// sqliteRecordedMigrationVersion returns the highest version recorded
// in schema_migrations. Returns (0, nil) when the table does not
// exist yet (fresh DB).
func sqliteRecordedMigrationVersion(db *sql.DB) (int, error) {
	var recorded int
	row := db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
	if err := row.Scan(&recorded); err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return 0, nil
		}
		return 0, err
	}
	return recorded, nil
}

// sqliteTableExists reports whether a table with the given name is
// present in the current SQLite database. Uses sqlite_master
// because PRAGMA table_info returns an empty row set for missing
// tables but is also what golang-migrate's own driver uses — the
// function still has to distinguish "table absent" from "table
// present with no columns" (the latter is impossible for our
// schema, but we still want the right answer for both).
func sqliteTableExists(db *sql.DB, name string) (bool, error) {
	row := db.QueryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", name)
	var x int
	if err := row.Scan(&x); err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// sqliteTableHasColumn returns true when `table` has a column named
// `column`. Uses PRAGMA table_info so the check works against any
// existing table without needing a fresh schema definition. Returns
// false (no error) when the table itself does not exist — the
// caller treats that as "column absent".
func sqliteTableHasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return false, nil
		}
		return false, err
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
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return false, nil
}