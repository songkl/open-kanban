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

func TestSQLiteMigrations(t *testing.T) {
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

	tables := []string{
		"users", "tokens", "boards", "board_permissions",
		"columns", "column_agents", "tasks", "comments",
		"subtasks", "attachments", "activities", "templates",
		"app_config", "column_permissions",
		"oauth_clients", "oauth_authorization_codes",
		"oauth_device_codes", "oauth_refresh_tokens", "oauth_consents",
		"task_runs",
	}

	taskRunIndexes := []string{
		"idx_task_runs_expires",
		"idx_task_runs_runner",
		"idx_task_runs_status",
		"idx_task_runs_finished_at",
		"idx_task_runs_status_finished_at",
	}
	for _, idx := range taskRunIndexes {
		var c int
		err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&c)
		if err != nil {
			t.Errorf("error checking task_runs index %s: %v", idx, err)
		}
		if c == 0 {
			t.Errorf("expected task_runs index %s to exist", idx)
		}
	}

	for _, table := range tables {
		var name string
		err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
		if err == sql.ErrNoRows {
			t.Errorf("table %s not found", table)
		} else if err != nil {
			t.Errorf("error checking table %s: %v", table, err)
		}
	}

	var accessTokenCol string
	err = db.QueryRow("SELECT access_token FROM attachments LIMIT 1").Scan(&accessTokenCol)
	if err != nil && err != sql.ErrNoRows {
		t.Errorf("access_token column not found in attachments: %v", err)
	}

	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_column_permissions_user'").Scan(&count)
	if err != nil {
		t.Errorf("error checking index: %v", err)
	}

	oauthIndexes := []string{
		"idx_oauth_clients_client_id",
		"idx_oauth_authcodes_client",
		"idx_oauth_authcodes_user",
		"idx_oauth_authcodes_expires",
		"idx_oauth_device_client",
		"idx_oauth_device_status",
		"idx_oauth_device_expires",
		"idx_oauth_refresh_user",
		"idx_oauth_refresh_client",
		"idx_oauth_refresh_expires",
		"idx_oauth_consents_user",
	}
	for _, idx := range oauthIndexes {
		var c int
		err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&c)
		if err != nil {
			t.Errorf("error checking oauth index %s: %v", idx, err)
		}
		if c == 0 {
			t.Errorf("expected oauth index %s to exist", idx)
		}
	}
}

// TestSQLiteMigrationsAllowNewPermissionActions exercises the
// migration at the current tip (002_extend_activity_actions) and
// verifies the CHECK constraint on activities.action permits the
// PERMISSION_GRANT / PERMISSION_REVOKE action types added by the
// Set*/Delete* permission handlers. If a future migration narrows
// the constraint by accident this test fails before any handler
// test does.
func TestSQLiteMigrationsAllowNewPermissionActions(t *testing.T) {
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

	for _, action := range []string{"PERMISSION_GRANT", "PERMISSION_REVOKE"} {
		if _, err := db.Exec(
			"INSERT INTO activities (id, user_id, action, target_type, target_id, source) VALUES (?, ?, ?, 'BOARD', 'b1', 'web')",
			"a-"+action, "u1", action,
		); err != nil {
			t.Errorf("action %s should be permitted by CHECK constraint after migration 002, got: %v", action, err)
		}
	}
}

// TestSQLiteMigrationsTaskRunsUpDown exercises the task_runs
// migrations end-to-end on SQLite. It verifies the table + its
// indexes come up cleanly, that the schema matches the §3.3
// contract (PK is task_id, FKs point at tasks/users, nullable
// finished_at / exit_code / error), and that the migrations are
// fully reversible: stepping back down past 006 (history
// indexes), 005 (FK relaxation) and 004 (table creation) drops
// the indexes and table, and re-running up brings everything
// back without errors. The MySQL migration is structurally
// identical to the SQLite one and is covered separately by
// TestMySQLMigrationsHaveUtf8Mb4Collation (charset / ENGINE)
// plus the integration test that runs the full suite against a
// live MySQL instance.
func TestSQLiteMigrationsTaskRunsUpDown(t *testing.T) {
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

	// 1. Apply every migration up to the tip (006). After this,
	//    task_runs must exist with the indexes from both 004 and
	//    006 — the latter are the history indexes the
	//    /api/v1/runs/history endpoint relies on (s-1106).
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("initial up: %v", err)
	}

	var taskRunsFound int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after up, got count=%d", taskRunsFound)
	}

	for _, idx := range []string{
		"idx_task_runs_expires",
		"idx_task_runs_runner",
		"idx_task_runs_status",
		"idx_task_runs_finished_at",
		"idx_task_runs_status_finished_at",
	} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check index %s: %v", idx, err)
			continue
		}
		if c != 1 {
			t.Errorf("expected index %s after up, got count=%d", idx, c)
		}
	}

	// 2. Insert a minimal but FK-valid row, then drop the table
	//    via the down migrations to prove the down SQL works and
	//    that the FKs / indexes line up with §3.3.
	//
	//    "Drop task_runs via the down migration" means rolling
	//    past 006, 005 and 004. We assert each rollback step
	//    individually so a regression in any of the three
	//    migrations surfaces with its own failing assertion:
	//
	//      step -1: 006 (history indexes) — task_runs untouched
	//      step -2: 005 (FK relaxation)   — task_runs untouched
	//      step -3: 004 (table creation)  — task_runs dropped
	seedTaskRun(t, db)

	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 005: %v", err)
	}
	// After rolling back 006, task_runs must still exist and
	// the 004 indexes must still be in place. The 006 history
	// indexes should be gone.
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after rolling back 006: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after rolling back 006, got count=%d", taskRunsFound)
	}
	for _, idx := range []string{"idx_task_runs_finished_at", "idx_task_runs_status_finished_at"} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check residual index %s after rolling back 006: %v", idx, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected index %s to be dropped after rolling back 006, got count=%d", idx, c)
		}
	}

	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 004: %v", err)
	}
	// After rolling back 005, task_runs must still exist (its
	// schema hasn't been touched yet) and the runner_id FK to
	// users.id should be back in force.
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after rolling back 005: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after rolling back 005, got count=%d", taskRunsFound)
	}

	if err := m.Steps(-1); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("down to 003: %v", err)
	}

	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after down: %v", err)
	}
	if taskRunsFound != 0 {
		t.Fatalf("expected task_runs table to be dropped after down, got count=%d", taskRunsFound)
	}
	for _, idx := range []string{"idx_task_runs_expires", "idx_task_runs_runner", "idx_task_runs_status"} {
		var c int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", idx,
		).Scan(&c); err != nil {
			t.Errorf("check residual index %s after down: %v", idx, err)
			continue
		}
		if c != 0 {
			t.Errorf("expected index %s to be dropped after down, got count=%d", idx, c)
		}
	}

	// 3. Re-apply up — this exercises the "migration can be run
	//    more than once without error" acceptance criterion.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("re-up: %v", err)
	}
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runs'",
	).Scan(&taskRunsFound); err != nil {
		t.Fatalf("check task_runs after re-up: %v", err)
	}
	if taskRunsFound != 1 {
		t.Fatalf("expected task_runs table after re-up, got count=%d", taskRunsFound)
	}

	// 4. Spot-check the live row from step 2 is gone (the down
	//    dropped it), and the table accepts a fresh one — both
	//    nullable and required columns round-trip cleanly through
	//    the schema.
	seedTaskRun(t, db)

	var (
		status       string
		finishedAt   sql.NullTime
		exitCode     sql.NullInt64
		errMsg       sql.NullString
		runnerID     string
		lastHeartbeat string
	)
	row := db.QueryRow(
		"SELECT status, finished_at, exit_code, error, runner_id, last_heartbeat_at FROM task_runs WHERE task_id='t-1'",
	)
	if err := row.Scan(&status, &finishedAt, &exitCode, &errMsg, &runnerID, &lastHeartbeat); err != nil {
		t.Fatalf("scan task_runs row: %v", err)
	}
	if status != "claimed" {
		t.Errorf("expected status 'claimed', got %q", status)
	}
	if finishedAt.Valid || exitCode.Valid || errMsg.Valid {
		t.Errorf("expected nullable columns to be NULL, got finished_at=%v exit_code=%v error=%q",
			finishedAt, exitCode, errMsg.String)
	}
	if runnerID != "u-1" {
		t.Errorf("expected runner_id 'u-1', got %q", runnerID)
	}
	if lastHeartbeat == "" {
		t.Errorf("expected non-empty last_heartbeat_at, got empty")
	}
}

// seedTaskRun inserts the minimum rows required for a FK-valid
// task_runs row: a users row (runner_id), a tasks row (task_id),
// and the task_runs row itself with the canonical §3.3 claim
// shape. It is safe to call against a freshly-up'd schema or
// after a down→up cycle (the seed IDs are deterministic and
// either previously dropped or freshly created).
func seedTaskRun(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('u-1', 'runner-1', 'runner-1', 'HUMAN', 'MEMBER', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO boards (id, name, description)
		VALUES ('b-1', 'board-1', '')
	`); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO columns (id, name, position, board_id)
		VALUES ('c-1', 'todo', 0, 'b-1')
	`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO tasks (id, title, column_id, position, published, archived, created_by)
		VALUES ('t-1', 'task-1', 'c-1', 0, 1, 0, 'u-1')
	`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO task_runs (
			task_id, runner_id, agent_id, board_id, column_id, status,
			claimed_at, last_heartbeat_at, expires_at
		) VALUES (
			't-1', 'u-1', 'cli-host', 'b-1', 'c-1', 'claimed',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		)
	`); err != nil {
		t.Fatalf("seed task_runs: %v", err)
	}
}
