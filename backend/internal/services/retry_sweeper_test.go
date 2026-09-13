package services_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

// setupRetrySweeperTestDB returns an in-memory SQLite with the
// webhooks + webhook_deliveries tables the retry sweeper
// touches. The schema mirrors migration-012 (see
// event_center_test.go for the canonical copy).
func setupRetrySweeperTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:retry_sweeper_test.db?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}
	if _, err := db.Exec(retrySweeperSchema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

const retrySweeperSchema = `
CREATE TABLE webhooks (
	id                  TEXT PRIMARY KEY,
	name                TEXT NOT NULL,
	url                 TEXT NOT NULL,
	secret              BLOB NOT NULL,
	enabled             INTEGER NOT NULL DEFAULT 1,
	event_types         TEXT NOT NULL DEFAULT '[]',
	filters             TEXT NOT NULL DEFAULT '{}',
	headers             TEXT NOT NULL DEFAULT '{}',
	timeout_sec         INTEGER NOT NULL DEFAULT 10,
	max_retries         INTEGER NOT NULL DEFAULT 5,
	created_by          TEXT,
	created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
	last_success_at     DATETIME,
	last_failure_at     DATETIME
);
CREATE TABLE webhook_deliveries (
	id              TEXT PRIMARY KEY,
	webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
	event_id        TEXT NOT NULL,
	event_type      TEXT NOT NULL,
	status          TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED')),
	attempt         INTEGER NOT NULL DEFAULT 1,
	request_body    TEXT NOT NULL DEFAULT '',
	response_code   INTEGER NOT NULL DEFAULT 0,
	response_body   TEXT NOT NULL DEFAULT '',
	error           TEXT NOT NULL DEFAULT '',
	started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
	finished_at     DATETIME,
	next_retry_at   DATETIME
);
`

// seedWebhookRetrySweeper inserts a single webhook with the
// supplied max_retries. Centralised so each test only declares
// the columns it cares about.
func seedWebhookRetrySweeper(t *testing.T, db *sql.DB, id, url string, maxRetries int) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO webhooks (id, name, url, secret, enabled, event_types, filters, headers, max_retries)
		VALUES (?, ?, ?, ?, 1, '["task.created"]', '{}', '{}', ?)
	`, id, id, url, []byte("k"), maxRetries); err != nil {
		t.Fatalf("seed webhook %s: %v", id, err)
	}
}

// seedDelivery inserts one FAILED delivery row with the
// supplied attempt counter and next_retry_at timestamp (false
// == due immediately). Returns the inserted id.
func seedDelivery(t *testing.T, db *sql.DB, webhookID, eventType string, attempt int, due bool) string {
	t.Helper()
	id := "del-" + webhookID + "-" + eventType
	var nextRetry interface{}
	if !due {
		farFuture := time.Now().Add(time.Hour).UTC()
		nextRetry = farFuture
	}
	body, _ := json.Marshal(map[string]any{"event": eventType})
	if _, err := db.Exec(`
		INSERT INTO webhook_deliveries
		    (id, webhook_id, event_id, event_type, status, attempt, request_body, started_at, finished_at, next_retry_at)
		VALUES (?, ?, 'evt-1', ?, 'FAILED', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
	`, id, webhookID, eventType, attempt, string(body), nextRetry); err != nil {
		t.Fatalf("seed delivery: %v", err)
	}
	return id
}

// captureRequeuer records every job the sweeper asks it to
// requeue. Concurrent-safe so tests can drive SweepOnce from a
// goroutine while the main goroutine inspects the snapshot.
//
// Implements services.DeliveryRequeuer.
type captureRequeuer struct {
	mu     sync.Mutex
	jobs   []*services.DeliveryJob
	calls  atomic.Int32
	errors atomic.Int32
}

func (r *captureRequeuer) Requeue(j *services.DeliveryJob) error {
	if j == nil {
		return nil
	}
	r.mu.Lock()
	r.jobs = append(r.jobs, j)
	r.mu.Unlock()
	r.calls.Add(1)
	return nil
}

func (r *captureRequeuer) snapshot() []*services.DeliveryJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*services.DeliveryJob, len(r.jobs))
	copy(out, r.jobs)
	return out
}

// ----------------------------------------------------------------------
// requeueDue
// ----------------------------------------------------------------------

func TestRetrySweeper_RequeueDue_PicksUpFailedRows(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()
	seedWebhookRetrySweeper(t, db, "wh-1", "https://example.com/hook", 5)

	// Two FAILED rows: one due (next_retry_at IS NULL) and one
	// due (next_retry_at <= now). Both should be re-enqueued.
	due := seedDelivery(t, db, "wh-1", "task.created", 1, true)
	seedDelivery(t, db, "wh-1", "task.moved", 2, true)
	// A FAILED row with next_retry_at far in the future must
	// NOT be touched.
	notDue := seedDelivery(t, db, "wh-1", "task.deleted", 3, false)

	rec := &captureRequeuer{}
	sweeper := services.NewRetrySweeper(db, nil, rec, time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	n, _, err := sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}
	if n != 2 {
		t.Errorf("re-enqueued count: got %d want 2", n)
	}

	got := rec.snapshot()
	if len(got) != 2 {
		t.Fatalf("expected 2 requeue calls; got %d", len(got))
	}

	ids := map[string]bool{}
	for _, j := range got {
		ids[j.DeliveryID] = true
		if j.Attempt < 2 {
			t.Errorf("attempt should be incremented from %d; got %d", j.Attempt-1, j.Attempt)
		}
	}
	for _, want := range []string{due, "del-wh-1-task.moved"} {
		if !ids[want] {
			t.Errorf("missing re-enqueued delivery %s", want)
		}
	}
	if ids[notDue] {
		t.Errorf("future-retry row %s must NOT be re-enqueued yet", notDue)
	}
}

// ----------------------------------------------------------------------
// markExhausted
// ----------------------------------------------------------------------

func TestRetrySweeper_Exhaustion_TransitionsAfterMaxRetries(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()
	// max_retries = 2; we insert attempt = 3 (over budget).
	seedWebhookRetrySweeper(t, db, "wh-1", "https://example.com/hook", 2)
	delID := seedDelivery(t, db, "wh-1", "task.created", 3, true)

	rec := &captureRequeuer{}
	sweeper := services.NewRetrySweeper(db, nil, rec, time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := sweeper.SweepOnce(ctx); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}

	var status string
	if err := db.QueryRow(
		"SELECT status FROM webhook_deliveries WHERE id = ?", delID,
	).Scan(&status); err != nil {
		t.Fatalf("query delivery: %v", err)
	}
	if status != "EXHAUSTED" {
		t.Errorf("status after exhaustion sweep: got %q want EXHAUSTED", status)
	}
}

func TestRetrySweeper_Exhaustion_KeepsRowOnBudget(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()
	// max_retries = 5; we insert attempt = 2 — under budget.
	seedWebhookRetrySweeper(t, db, "wh-1", "https://example.com/hook", 5)
	delID := seedDelivery(t, db, "wh-1", "task.created", 2, true)

	rec := &captureRequeuer{}
	sweeper := services.NewRetrySweeper(db, nil, rec, time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := sweeper.SweepOnce(ctx); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}

	var status string
	if err := db.QueryRow(
		"SELECT status FROM webhook_deliveries WHERE id = ?", delID,
	).Scan(&status); err != nil {
		t.Fatalf("query delivery: %v", err)
	}
	if status != "FAILED" {
		t.Errorf("status should remain FAILED when under budget; got %q", status)
	}
}

// ----------------------------------------------------------------------
// lifecycle
// ----------------------------------------------------------------------

func TestRetrySweeper_StartStop_Idempotent(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()

	rec := &captureRequeuer{}
	sweeper := services.NewRetrySweeper(db, nil, rec, 50*time.Millisecond)
	sweeper.Start()
	sweeper.Start() // second call is a no-op

	sweeper.Stop()
	sweeper.Stop() // second call is a no-op
}

func TestRetrySweeper_StopWithoutStartIsSafe(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()
	rec := &captureRequeuer{}
	sweeper := services.NewRetrySweeper(db, nil, rec, time.Second)
	sweeper.Stop()
}

// ----------------------------------------------------------------------
// requeue rejection — verify a Requeue failure doesn't strand
// the row in FAILED with a bumped attempt counter.
// ----------------------------------------------------------------------

// rejectingRequeuer returns an error from every Requeue call so
// the sweeper's rollback path is exercised.
type rejectingRequeuer struct{}

func (rejectingRequeuer) Requeue(*services.DeliveryJob) error {
	return context.Canceled
}

func TestRetrySweeper_RequeueError_LeavesAttemptUnchanged(t *testing.T) {
	db := setupRetrySweeperTestDB(t)
	defer db.Close()
	seedWebhookRetrySweeper(t, db, "wh-1", "https://example.com/hook", 5)
	delID := seedDelivery(t, db, "wh-1", "task.created", 1, true)

	sweeper := services.NewRetrySweeper(db, nil, rejectingRequeuer{}, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := sweeper.SweepOnce(ctx); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}

	var (
		status  string
		attempt int
	)
	if err := db.QueryRow(
		"SELECT status, attempt FROM webhook_deliveries WHERE id = ?", delID,
	).Scan(&status, &attempt); err != nil {
		t.Fatalf("query delivery: %v", err)
	}
	if status != "FAILED" {
		t.Errorf("status should stay FAILED on requeue error; got %q", status)
	}
	if attempt != 1 {
		t.Errorf("attempt must roll back after requeue failure; got %d", attempt)
	}
}
