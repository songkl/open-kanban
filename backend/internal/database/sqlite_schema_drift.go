package database

import (
	"database/sql"
	"strings"
)

// sqliteSchemaDrift reports whether the recorded schema_migrations
// version is out of sync with the actual schema. It returns true
// when the recorded version claims migration 4 or later was applied
// but ANY post-004 canary schema element is missing — meaning the
// recorded version is untrustworthy and the runner should rewind
// before calling m.Up(). On a fresh DB the schema_migrations table
// does not exist yet; that case is treated as "no drift" so the
// runner still applies the migrations normally.
//
// The check walks every canary in sqliteSchemaCanaries rather than
// only is_public: migrations 009 (notifications), 010
// (preset_templates), 012 (user_notification_preferences), 013
// (viewer_tokens), and 016 (frontend_events) introduce brand-new
// tables that don't depend on boards.is_public, so an is_public-only
// check would miss drift where, e.g., the notifications table was
// dropped but the boards table is otherwise intact (s-1219).
func sqliteSchemaDrift(db *sql.DB) (bool, error) {
	recorded, err := sqliteRecordedMigrationVersion(db)
	if err != nil {
		return false, err
	}
	if recorded < 16 {
		return false, nil
	}
	for _, c := range sqliteSchemaCanaries {
		var present bool
		if c.column == "" {
			present, err = sqliteTableExists(db, c.table)
		} else {
			present, err = sqliteTableHasColumn(db, c.table, c.column)
		}
		if err != nil {
			return false, err
		}
		if !present {
			return true, nil
		}
	}
	return false, nil
}

// sqliteSchemaCanary describes a single schema element (table or
// column) that the named migration is the FIRST to introduce. The
// list is the source of truth for both sqliteSchemaDrift and
// sqliteEffectiveMigrationVersion — keeping one definition ensures
// the two checks stay in sync as new migrations are added.
type sqliteSchemaCanary struct {
	version int
	table   string
	column  string // empty means "table itself is the canary"
}

// sqliteSchemaCanaries is the ordered list of canary schema elements
// covering every post-004 migration. Order is significant: each
// entry's version must be strictly greater than the previous one,
// and the effective-version walker stops at the first missing canary
// to preserve the monotonicity assumption (migrations are applied
// in order). When adding a new migration, append its canary here.
var sqliteSchemaCanaries = []sqliteSchemaCanary{
	{16, "boards", "is_public"},                 // 016 add_board_visibility (renumbered from workthree's 004)
	{21, "notifications", ""},                   // 021 add_notifications (renumbered from workthree's 009)
	{22, "preset_templates", ""},                // 022 add_preset_templates (renumbered from workthree's 010)
	{23, "column_agents", "transition_trigger"}, // 023 add_column_agent_transition_trigger (renumbered from 011)
	{24, "user_notification_preferences", ""},   // 024 add_user_notification_preferences (renumbered from 012)
	{25, "viewer_tokens", ""},                   // 025 add_viewer_tokens (renumbered from workthree's 013)
	{26, "tasks", "due_at"},                     // 026 add_task_due_at (renumbered from workthree's 014)
	{28, "frontend_events", ""},                 // 028 add_frontend_events (renumbered from workthree's 016)
}

// sqliteEffectiveMigrationVersion inspects the actual schema and
// returns the migration version one below the FIRST missing canary
// — regardless of what schema_migrations.version says. This is used
// to recover from the s-1217 drift state where the recorded version
// is ahead of the actual schema and m.Up() refuses to re-apply
// anything.
//
// Strategy: scan canaries in order. The first canary that is MISSING
// marks the rewind target — return (that version - 1). If every
// canary is present, return the highest canary version. If the
// first canary is missing, return 0 (the runner maps this to
// NilVersion so m.Up() starts from the first embedded migration).
//
// The rewind-to-(missing-1) target means m.Up() replays only the
// gap: migrations that ADD the missing canary through the latest.
// Already-applied migrations from earlier (including the
// monotonic ALTER TABLE ADD COLUMN steps) stay applied, so no
// "duplicate column" failures.
func sqliteEffectiveMigrationVersion(db *sql.DB) (int, error) {
	for _, c := range sqliteSchemaCanaries {
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
			// First missing canary — return one below it so
			// m.Up() starts from the migration that adds this
			// canary, not from one above it (which would skip
			// the very migration we want to replay).
			if c.version <= 1 {
				return 0, nil
			}
			return c.version - 1, nil
		}
	}
	// Every canary present — return the highest so the runner can
	// short-circuit to m.Up() (which will hit ErrNoChange because
	// the recorded version is already at-or-above this value).
	return sqliteSchemaCanaries[len(sqliteSchemaCanaries)-1].version, nil
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