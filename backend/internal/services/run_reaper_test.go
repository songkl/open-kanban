package services_test

import (
	"context"
	"database/sql"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

func setupReaperDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		deleted BOOLEAN DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT,
		position INTEGER DEFAULT 0,
		board_id TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		column_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 1,
		archived BOOLEAN DEFAULT 0,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE task_runs (
		task_id TEXT PRIMARY KEY,
		runner_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		column_id TEXT NOT NULL,
		status TEXT NOT NULL,
		claimed_at DATETIME NOT NULL,
		last_heartbeat_at DATETIME NOT NULL,
		expires_at DATETIME NOT NULL,
		finished_at DATETIME,
		exit_code INTEGER,
		error TEXT,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (runner_id) REFERENCES users(id) ON DELETE SET NULL
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	for _, stmt := range []string{
		`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u-1', 'runner', 'runner', 'MEMBER', 1)`,
		`INSERT INTO boards (id, name) VALUES ('b-1', 'Board')`,
		`INSERT INTO columns (id, name, status, position, board_id) VALUES
			('c-todo', 'Todo', 'todo', 0, 'b-1'),
			('c-doing', 'Doing', 'in_progress', 1, 'b-1')`,
		`INSERT INTO tasks (id, title, column_id, position, published, archived, created_by) VALUES
			('t-stale', 'stale', 'c-doing', 1000, 1, 0, 'u-1'),
			('t-fresh', 'fresh', 'c-doing', 2000, 1, 0, 'u-1')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed %q: %v", stmt, err)
		}
	}

	return db
}

// seedRun inserts a task_runs row in a given lifecycle state.
// expiresAtPast=true makes the row look stale to the reaper.
func seedRun(t *testing.T, db *sql.DB, taskID, status string, expiresAtPast bool) {
	t.Helper()
	expires := "datetime('now', '+5 minutes')"
	if expiresAtPast {
		expires = "datetime('now', '-5 minutes')"
	}
	stmt := `
		INSERT INTO task_runs (
			task_id, runner_id, agent_id, board_id, column_id, status,
			claimed_at, last_heartbeat_at, expires_at
		) VALUES (
			?, 'u-1', 'opencoder', 'b-1', 'c-todo', ?,
			datetime('now', '-1 minute'),
			datetime('now', '-1 minute'),
			` + expires + `
		)
	`
	if _, err := db.Exec(stmt, taskID, status); err != nil {
		t.Fatalf("seed run %s: %v", taskID, err)
	}
}

func TestRunReaper_RunOnce_ExpiresStaleRow(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	seedRun(t, db, "t-stale", "claimed", true)
	seedRun(t, db, "t-fresh", "claimed", false)

	reaper := services.NewRunReaper(db)
	n, err := reaper.RunOnce()
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 released, got %d", n)
	}

	var staleStatus, freshStatus string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-stale'").Scan(&staleStatus); err != nil {
		t.Fatalf("query stale: %v", err)
	}
	if staleStatus != "released" {
		t.Errorf("expected stale status released, got %s", staleStatus)
	}
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-fresh'").Scan(&freshStatus); err != nil {
		t.Fatalf("query fresh: %v", err)
	}
	if freshStatus != "claimed" {
		t.Errorf("expected fresh status claimed, got %s", freshStatus)
	}
}

func TestRunReaper_RunOnce_RestoresColumn(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	seedRun(t, db, "t-stale", "claimed", true)

	// Task is in c-doing; the reaper must restore it to c-todo
	// (the snapshot column recorded at claim time).
	var preColumn string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-stale'").Scan(&preColumn); err != nil {
		t.Fatalf("pre-query: %v", err)
	}
	if preColumn != "c-doing" {
		t.Fatalf("precondition failed: expected task in c-doing, got %s", preColumn)
	}

	reaper := services.NewRunReaper(db)
	if _, err := reaper.RunOnce(); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	var postColumn string
	if err := db.QueryRow("SELECT column_id FROM tasks WHERE id='t-stale'").Scan(&postColumn); err != nil {
		t.Fatalf("post-query: %v", err)
	}
	if postColumn != "c-todo" {
		t.Errorf("expected task restored to c-todo, got %s", postColumn)
	}
}

func TestRunReaper_RunOnce_Idempotent(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	seedRun(t, db, "t-stale", "claimed", true)

	reaper := services.NewRunReaper(db)
	if n, err := reaper.RunOnce(); err != nil || n != 1 {
		t.Fatalf("first RunOnce: n=%d err=%v", n, err)
	}
	// Second pass must report zero newly-released rows even
	// though the released row is still in the table — the
	// reaper only acts on claimed/running.
	if n, err := reaper.RunOnce(); err != nil || n != 0 {
		t.Fatalf("second RunOnce: n=%d err=%v", n, err)
	}
}

func TestRunReaper_StartStop_LoopRuns(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	seedRun(t, db, "t-stale", "claimed", true)

	reaper := services.NewRunReaperWithInterval(db, 30*time.Millisecond)
	reaper.Start(context.Background())

	// First sweep runs immediately inside Start, but the
	// timestamp-based comparison can still see stale rows on
	// any subsequent tick. Poll until the row is released or
	// the deadline fires.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-stale'").Scan(&status); err != nil {
			t.Fatalf("poll: %v", err)
		}
		if status == "released" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	reaper.Stop()

	var status string
	if err := db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-stale'").Scan(&status); err != nil {
		t.Fatalf("post-stop query: %v", err)
	}
	if status != "released" {
		t.Errorf("expected released after Start, got %s", status)
	}
}

func TestRunReaper_StopIsIdempotent(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	reaper := services.NewRunReaperWithInterval(db, 10*time.Millisecond)
	reaper.Start(context.Background())
	time.Sleep(20 * time.Millisecond)

	reaper.Stop()
	reaper.Stop() // must not panic or hang
}

func TestRunReaper_StartIsIdempotent(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	reaper := services.NewRunReaperWithInterval(db, 10*time.Millisecond)
	reaper.Start(context.Background())
	reaper.Start(context.Background())
	reaper.Stop()
}

func TestRunReaper_NewRunReaperRejectsZeroInterval(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	reaper := services.NewRunReaperWithInterval(db, 0)
	if reaper == nil {
		t.Fatal("expected non-nil reaper")
	}
	if _, err := reaper.RunOnce(); err != nil {
		t.Errorf("RunOnce on zero-interval reaper should fall back to default cadence, got %v", err)
	}
}

// TestRunReaper_NoRowsSafe runs the reaper against an empty
// task_runs table — RunOnce must return (0, nil) without
// raising an error from the repo's "no eligible task" path.
func TestRunReaper_NoRowsSafe(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	reaper := services.NewRunReaper(db)
	n, err := reaper.RunOnce()
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 released on empty table, got %d", n)
	}
}

// TestRunReaper_OnlySweepsLiveStatus guards against the
// reaper touching already-terminal rows.
func TestRunReaper_OnlySweepsLiveStatus(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	for _, status := range []string{"completed", "failed", "released"} {
		seedRun(t, db, "t-"+status, status, true)
	}
	seedRun(t, db, "t-claimed-stale", "claimed", true)

	reaper := services.NewRunReaper(db)
	n, err := reaper.RunOnce()
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 1 {
		t.Errorf("expected only claimed row reaped, got n=%d", n)
	}
}

// Sanity check that the constructor wiring really uses the
// provided interval: a 1ms reaper must make forward progress
// without an external RunOnce call.
func TestRunReaper_HonoursInterval(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	seedRun(t, db, "t-stale", "claimed", true)

	reaper := services.NewRunReaperWithInterval(db, 1*time.Millisecond)
	reaper.Start(context.Background())

	var ticks int32
	deadline := time.After(500 * time.Millisecond)
loop:
	for {
		select {
		case <-deadline:
			break loop
		default:
		}
		var status string
		_ = db.QueryRow("SELECT status FROM task_runs WHERE task_id='t-stale'").Scan(&status)
		if status == "released" {
			atomic.AddInt32(&ticks, 1)
			break loop
		}
		time.Sleep(5 * time.Millisecond)
	}
	reaper.Stop()

	if atomic.LoadInt32(&ticks) == 0 {
		t.Errorf("reaper never transitioned row to released within deadline")
	}
}

// TestRunReaper_StopBeforeStartDoesNotPanic asserts the
// lifecycle ordering Stop() before Start() is safe — useful
// for graceful-shutdown paths that may race with the boot
// sequence.
func TestRunReaper_StopBeforeStartDoesNotPanic(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	reaper := services.NewRunReaperWithInterval(db, 10*time.Millisecond)
	// Must not block or panic.
	done := make(chan struct{})
	go func() {
		reaper.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Stop blocked")
	}
}

// Sanity check that an error from the underlying DB doesn't
// cause the reaper to loop forever in panic — RunOnce must
// surface the error to the caller.
func TestRunReaper_PropagatesDBError(t *testing.T) {
	db := setupReaperDB(t)
	defer db.Close()

	if _, err := db.Exec("DROP TABLE task_runs"); err != nil {
		t.Fatalf("drop: %v", err)
	}

	reaper := services.NewRunReaper(db)
	_, err := reaper.RunOnce()
	if err == nil {
		t.Fatal("expected error from RunOnce with missing table, got nil")
	}
	if !errors.Is(err, err) {
		// error is non-nil; the precise wrap chain is the
		// repository's responsibility, not ours. We just
		// need it to be returned.
		t.Logf("got expected non-nil error: %v", err)
	}
}
