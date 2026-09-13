package services_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

// setupEventCenterTestDB returns an in-memory SQLite with
// the webhooks + webhook_deliveries tables the dispatcher
// touches. Matches the migration-012 schema so the
// INSERTs the SQLDBDispatcher issues match the columns
// (and CHECK constraints) the production migration
// creates.
//
// `mode=memory&cache=shared` + SetMaxOpenConns(1) keep the
// background dispatcher goroutine and the test goroutine
// on the same connection so they share a coherent schema
// view — without it, go-sqlite3 hands each pooled
// connection a private :memory: database.
func setupEventCenterTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:event_center_test.db?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	schema := `
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

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

// seedWebhook inserts one webhook row with the supplied
// event_types JSON and filters JSON. Centralised so each
// test only declares the columns it cares about.
func seedWebhook(t *testing.T, db *sql.DB, id, url, eventTypes, filters string) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO webhooks (id, name, url, secret, enabled, event_types, filters, headers)
		VALUES (?, ?, ?, ?, 1, ?, ?, '{}')
	`, id, id, url, []byte("k"), eventTypes, filters); err != nil {
		t.Fatalf("seed webhook %s: %v", id, err)
	}
}

// fakeEvent is the test Event implementation. Filterable so
// filter tests can exercise the board / column / priority /
// assignee matchers.
type fakeEvent struct {
	typ      string
	id       string
	at       time.Time
	data     any
	boardID  string
	columnID string
	priority string
	assignee string
}

func (e *fakeEvent) EventType() string     { return e.typ }
func (e *fakeEvent) EnvelopeID() string    { return e.id }
func (e *fakeEvent) OccurredAt() time.Time { return e.at }
func (e *fakeEvent) Data() any             { return e.data }

func (e *fakeEvent) FilterBoardID() string  { return e.boardID }
func (e *fakeEvent) FilterColumnID() string { return e.columnID }
func (e *fakeEvent) FilterPriority() string { return e.priority }
func (e *fakeEvent) FilterAssignee() string { return e.assignee }

// ----------------------------------------------------------------------
// EventBus contract tests
// ----------------------------------------------------------------------

func TestChannelEventBus_Publish_DeliversToChannel(t *testing.T) {
	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	ev := &fakeEvent{typ: "task.created", id: "evt-1", at: time.Now().UTC()}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	select {
	case got := <-bus.Channel():
		if got != ev {
			t.Errorf("Publish delivered a different event pointer than was enqueued")
		}
	case <-time.After(time.Second):
		t.Fatal("Publish did not deliver to the channel within 1s")
	}
}

func TestChannelEventBus_Publish_NilEventRejected(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()

	if err := bus.Publish(nil); err == nil {
		t.Fatal("Publish(nil) should return an error")
	}
}

func TestChannelEventBus_Publish_AfterCloseReturnsErr(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	if err := bus.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt-1"}); !errors.Is(err, services.ErrBusClosed) {
		t.Errorf("Publish after Close err = %v, want ErrBusClosed", err)
	}
}

func TestChannelEventBus_Close_IsIdempotent(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	if err := bus.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := bus.Close(); err != nil {
		t.Errorf("second Close should be a no-op; got %v", err)
	}
}

func TestChannelEventBus_ChannelCapacity(t *testing.T) {
	bus := services.NewChannelEventBus(2)
	defer bus.Close()

	// Two non-blocking publishes fill the buffer.
	for i := 0; i < 2; i++ {
		if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt"}); err != nil {
			t.Fatalf("Publish #%d: %v", i, err)
		}
	}

	done := make(chan error, 1)
	go func() {
		// Third publish should block until the test reads.
		done <- bus.Publish(&fakeEvent{typ: "task.created", id: "evt-3"})
	}()

	select {
	case err := <-done:
		t.Fatalf("third Publish returned without a reader: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	// Drain one slot — the goroutine should now unblock.
	<-bus.Channel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("third Publish err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("third Publish did not unblock after a slot was freed")
	}
}

// ----------------------------------------------------------------------
// EventCenter dispatcher integration tests
// ----------------------------------------------------------------------

// recorderDeliverFunc is a DeliverFunc that records every
// job it's called with. Tests use the slice + sync.WaitGroup
// to assert fan-out without blocking on a real receiver.
type recorderDeliverFunc struct {
	mu   sync.Mutex
	jobs []*services.DeliveryJob
	wg   sync.WaitGroup
}

func (r *recorderDeliverFunc) deliver(ctx context.Context, job *services.DeliveryJob) error {
	r.mu.Lock()
	r.jobs = append(r.jobs, job)
	r.mu.Unlock()
	r.wg.Done()
	return nil
}

func (r *recorderDeliverFunc) snapshot() []*services.DeliveryJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*services.DeliveryJob, len(r.jobs))
	copy(out, r.jobs)
	return out
}

func TestEventCenter_FanOut_SingleEvent_MultipleWebhooks(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	// Three webhooks, all subscribe to task.created with no
	// filters → one publish must produce three delivery rows
	// and three worker jobs.
	seedWebhook(t, db, "wh-1", "https://example.com/1", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-2", "https://example.com/2", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-3", "https://example.com/3", `["task.created"]`, `{}`)

	bus := services.NewChannelEventBus(4)
	rec := &recorderDeliverFunc{}
	rec.wg.Add(3)
	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{typ: "task.created", id: "evt-fanout", at: time.Now().UTC()}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if !waitForJobs(&rec.wg, 2*time.Second) {
		t.Fatalf("expected 3 worker jobs within 2s; got %d", len(rec.snapshot()))
	}

	jobs := rec.snapshot()
	if len(jobs) != 3 {
		t.Fatalf("expected 3 delivery jobs, got %d", len(jobs))
	}
	webhookIDs := map[string]bool{}
	for _, j := range jobs {
		webhookIDs[j.WebhookID] = true
		if j.EventID != "evt-fanout" {
			t.Errorf("job EventID: got %q want %q", j.EventID, "evt-fanout")
		}
		if j.EventType != "task.created" {
			t.Errorf("job EventType: got %q want %q", j.EventType, "task.created")
		}
		if j.Attempt != 1 {
			t.Errorf("job Attempt: got %d want 1", j.Attempt)
		}
		if len(j.Body) == 0 {
			t.Error("job Body should contain the rendered envelope")
		}
	}
	for _, want := range []string{"wh-1", "wh-2", "wh-3"} {
		if !webhookIDs[want] {
			t.Errorf("missing worker job for webhook %s", want)
		}
	}

	// Three PENDING rows should also be in webhook_deliveries.
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM webhook_deliveries WHERE event_id = ?", "evt-fanout").Scan(&n); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if n != 3 {
		t.Errorf("webhook_deliveries rows: got %d want 3", n)
	}
	var status string
	if err := db.QueryRow("SELECT status FROM webhook_deliveries WHERE event_id = ? LIMIT 1", "evt-fanout").Scan(&status); err != nil {
		t.Fatalf("query delivery status: %v", err)
	}
	if status != "PENDING" {
		t.Errorf("delivery status: got %q want PENDING", status)
	}
}

func TestEventCenter_NoMatchingWebhooks_IsNoOp(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	seedWebhook(t, db, "wh-other", "https://example.com/other", `["task.moved"]`, `{}`)

	bus := services.NewChannelEventBus(1)
	rec := &recorderDeliverFunc{}
	center := services.NewEventCenter(db, bus, 1)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{typ: "task.created", id: "evt-no-match", at: time.Now().UTC()}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// No webhooks subscribe to task.created → no jobs, no rows.
	// Give the dispatcher a moment to confirm it didn't pick
	// anything up anyway.
	time.Sleep(100 * time.Millisecond)

	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("expected no worker jobs, got %d", len(got))
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM webhook_deliveries WHERE event_id = ?", "evt-no-match").Scan(&n); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if n != 0 {
		t.Errorf("webhook_deliveries rows: got %d want 0", n)
	}
}

func TestEventCenter_DisabledWebhooksAreSkipped(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	seedWebhook(t, db, "wh-enabled", "https://example.com/on", `["task.created"]`, `{}`)
	if _, err := db.Exec(`INSERT INTO webhooks (id, name, url, secret, enabled, event_types) VALUES ('wh-disabled', 'wh-disabled', 'https://example.com/off', ?, 0, '["task.created"]')`, []byte("k")); err != nil {
		t.Fatalf("seed disabled webhook: %v", err)
	}

	bus := services.NewChannelEventBus(1)
	rec := &recorderDeliverFunc{}
	rec.wg.Add(1)
	center := services.NewEventCenter(db, bus, 1)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt-enabled", at: time.Now().UTC()}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if !waitForJobs(&rec.wg, 2*time.Second) {
		t.Fatalf("expected exactly 1 worker job, got %d", len(rec.snapshot()))
	}
	jobs := rec.snapshot()
	if jobs[0].WebhookID != "wh-enabled" {
		t.Errorf("expected job for wh-enabled; got %s", jobs[0].WebhookID)
	}
}

// ----------------------------------------------------------------------
// Filter tests — exercise the §3.2 matchers end-to-end through the
// SQLDBDispatcher.
// ----------------------------------------------------------------------

func TestEventCenter_FilterHit(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	seedWebhook(t, db, "wh-board", "https://example.com/board",
		`["task.created"]`, `{"boardIds":["b-1"]}`)
	seedWebhook(t, db, "wh-column", "https://example.com/column",
		`["task.created"]`, `{"columnIds":["c-1"]}`)
	seedWebhook(t, db, "wh-priority", "https://example.com/priority",
		`["task.created"]`, `{"priorities":["high"]}`)
	seedWebhook(t, db, "wh-assignee", "https://example.com/assignee",
		`["task.created"]`, `{"assigneeIds":["u-1"]}`)

	bus := services.NewChannelEventBus(1)
	rec := &recorderDeliverFunc{}
	rec.wg.Add(4)
	center := services.NewEventCenter(db, bus, 4)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ:      "task.created",
		id:       "evt-hit",
		at:       time.Now().UTC(),
		boardID:  "b-1",
		columnID: "c-1",
		priority: "high",
		assignee: "u-1",
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if !waitForJobs(&rec.wg, 2*time.Second) {
		t.Fatalf("expected 4 worker jobs (all filters hit), got %d", len(rec.snapshot()))
	}
	webhookIDs := map[string]bool{}
	for _, j := range rec.snapshot() {
		webhookIDs[j.WebhookID] = true
	}
	for _, want := range []string{"wh-board", "wh-column", "wh-priority", "wh-assignee"} {
		if !webhookIDs[want] {
			t.Errorf("expected filter hit for %s; webhook was skipped", want)
		}
	}
}

func TestEventCenter_FilterMiss(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	// Webhook demands a different board / column / priority / assignee
	// than what the event reports → all four filters must reject.
	seedWebhook(t, db, "wh-board-miss", "https://example.com/b",
		`["task.created"]`, `{"boardIds":["b-other"]}`)
	seedWebhook(t, db, "wh-column-miss", "https://example.com/c",
		`["task.created"]`, `{"columnIds":["c-other"]}`)
	seedWebhook(t, db, "wh-priority-miss", "https://example.com/p",
		`["task.created"]`, `{"priorities":["low"]}`)
	seedWebhook(t, db, "wh-assignee-miss", "https://example.com/a",
		`["task.created"]`, `{"assigneeIds":["u-other"]}`)

	bus := services.NewChannelEventBus(1)
	rec := &recorderDeliverFunc{}
	center := services.NewEventCenter(db, bus, 1)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ:      "task.created",
		id:       "evt-miss",
		at:       time.Now().UTC(),
		boardID:  "b-1",
		columnID: "c-1",
		priority: "high",
		assignee: "u-1",
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Give the dispatcher enough wall-clock time to confirm
	// nothing arrives.
	time.Sleep(100 * time.Millisecond)

	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("expected 0 worker jobs (all filters missed); got %d", len(got))
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM webhook_deliveries WHERE event_id = ?", "evt-miss").Scan(&n); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if n != 0 {
		t.Errorf("webhook_deliveries rows: got %d want 0", n)
	}
}

func TestEventCenter_FilterAndAcrossCategories(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	// Two filters: boardIds AND priority. The event has the
	// matching board but the wrong priority → must miss.
	seedWebhook(t, db, "wh-and", "https://example.com/and",
		`["task.created"]`, `{"boardIds":["b-1"],"priorities":["low"]}`)

	bus := services.NewChannelEventBus(1)
	rec := &recorderDeliverFunc{}
	center := services.NewEventCenter(db, bus, 1)
	center.SetDeliverFunc(rec.deliver)
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ:      "task.created",
		id:       "evt-and",
		at:       time.Now().UTC(),
		boardID:  "b-1",
		priority: "high",
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	time.Sleep(100 * time.Millisecond)

	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("AND across categories must miss when one dimension fails; got %d jobs", len(got))
	}
}

// ----------------------------------------------------------------------
// Worker pool sizing — the s-1141 spec calls out "worker count limit"
// coverage.
// ----------------------------------------------------------------------

func TestEventCenter_WorkerCount_HonoursConstructorArgument(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	c := services.NewEventCenter(nil, bus, 7)
	if got := c.WorkerCount(); got != 7 {
		t.Errorf("WorkerCount: got %d want 7", got)
	}
}

func TestEventCenter_WorkerCount_FallsBackToEnv(t *testing.T) {
	t.Setenv("WEBHOOK_WORKERS", "9")
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	c := services.NewEventCenter(nil, bus, 0)
	if got := c.WorkerCount(); got != 9 {
		t.Errorf("WorkerCount from env: got %d want 9", got)
	}
}

func TestEventCenter_WorkerCount_FallsBackToDefault(t *testing.T) {
	t.Setenv("WEBHOOK_WORKERS", "")
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	c := services.NewEventCenter(nil, bus, 0)
	if got := c.WorkerCount(); got != services.DefaultWorkerCount {
		t.Errorf("WorkerCount default: got %d want %d", got, services.DefaultWorkerCount)
	}
}

func TestEventCenter_WorkerCount_RejectsInvalidEnv(t *testing.T) {
	t.Setenv("WEBHOOK_WORKERS", "not-a-number")
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	c := services.NewEventCenter(nil, bus, 0)
	if got := c.WorkerCount(); got != services.DefaultWorkerCount {
		t.Errorf("invalid env should fall back to default; got %d want %d", got, services.DefaultWorkerCount)
	}
}

func TestEventCenter_WorkerCount_CapsAtMax(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	c := services.NewEventCenter(nil, bus, 100000)
	if got := c.WorkerCount(); got > 256 {
		t.Errorf("worker count must be capped; got %d", got)
	}
}

func TestEventCenter_DispatchLoop_OnlySpawnsConfiguredWorkers(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	// 12 webhooks all subscribe to task.created, but the pool
	// only has 3 workers. Use a deliver function that blocks
	// so we can observe concurrency: the maximum number of
	// simultaneously-running deliver calls must not exceed
	// the pool size.
	const poolSize = 3
	const totalJobs = 12

	seedWebhook(t, db, "wh-1", "https://example.com/1", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-2", "https://example.com/2", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-3", "https://example.com/3", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-4", "https://example.com/4", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-5", "https://example.com/5", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-6", "https://example.com/6", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-7", "https://example.com/7", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-8", "https://example.com/8", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-9", "https://example.com/9", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-10", "https://example.com/10", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-11", "https://example.com/11", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-12", "https://example.com/12", `["task.created"]`, `{}`)

	var (
		inFlight  atomic.Int32
		peakSeen  atomic.Int32
		doneJobs  atomic.Int32
		releaseCh = make(chan struct{})
		allDone   = make(chan struct{})
	)
	deliver := func(ctx context.Context, job *services.DeliveryJob) error {
		cur := inFlight.Add(1)
		// Track the peak concurrency; if the pool size cap
		// is honoured, this never exceeds poolSize.
		for {
			old := peakSeen.Load()
			if cur <= old || peakSeen.CompareAndSwap(old, cur) {
				break
			}
		}
		<-releaseCh
		inFlight.Add(-1)
		if doneJobs.Add(1) == int32(totalJobs) {
			close(allDone)
		}
		return nil
	}

	bus := services.NewChannelEventBus(1)
	center := services.NewEventCenter(db, bus, poolSize)
	center.SetDeliverFunc(deliver)
	center.Start()

	if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt-pool", at: time.Now().UTC()}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Give the dispatcher enough time to fan out all 12 jobs
	// into the delivery queue and for poolSize workers to
	// pick them up.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && peakSeen.Load() < int32(poolSize) {
		time.Sleep(10 * time.Millisecond)
	}
	if peakSeen.Load() > int32(poolSize) {
		t.Errorf("peak concurrent deliver calls exceeded pool size: got %d, want <= %d", peakSeen.Load(), poolSize)
	}

	// Release all blocked delivers and wait for them to drain.
	close(releaseCh)
	select {
	case <-allDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("deliver did not drain: %d/%d done", doneJobs.Load(), totalJobs)
	}

	center.Stop()

	if got := doneJobs.Load(); got != int32(totalJobs) {
		t.Errorf("deliver invocations: got %d want %d", got, totalJobs)
	}
	if peak := peakSeen.Load(); peak < 1 {
		t.Errorf("expected at least one concurrent deliver; peak = %d", peak)
	}
	if peak := peakSeen.Load(); peak > int32(poolSize) {
		t.Errorf("peak concurrent deliver calls exceeded pool size: got %d, want <= %d", peak, poolSize)
	}
}

// ----------------------------------------------------------------------
// Graceful shutdown — context.Cancel + WaitGroup per the s-1141 spec.
// ----------------------------------------------------------------------

func TestEventCenter_Stop_GracefulShutdownDrainsQueuedJobs(t *testing.T) {
	db := setupEventCenterTestDB(t)
	defer db.Close()

	seedWebhook(t, db, "wh-1", "https://example.com/1", `["task.created"]`, `{}`)
	seedWebhook(t, db, "wh-2", "https://example.com/2", `["task.created"]`, `{}`)

	delivered := make(chan *services.DeliveryJob, 4)
	deliver := func(ctx context.Context, job *services.DeliveryJob) error {
		delivered <- job
		return nil
	}

	bus := services.NewChannelEventBus(8)
	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(deliver)
	center.Start()

	if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt-shutdown", at: time.Now().UTC()}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Wait for both deliveries to be picked up by workers.
	for i := 0; i < 2; i++ {
		select {
		case <-delivered:
		case <-time.After(time.Second):
			t.Fatalf("worker did not pick up job %d within 1s", i)
		}
	}

	// Stop must return promptly (well under the 5s timeout
	// the test runner uses for slow operations).
	done := make(chan struct{})
	go func() {
		center.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("EventCenter.Stop did not return within 2s")
	}
}

func TestEventCenter_Stop_WithoutStartIsSafe(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	center := services.NewEventCenter(nil, bus, 1)
	center.Stop()
	center.Stop()
}

func TestEventCenter_Start_IsIdempotent(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	center := services.NewEventCenter(nil, bus, 1)
	center.Start()
	center.Start()
	center.Stop()
}

func TestEventCenter_PublishAfterBusCloseReturnsErr(t *testing.T) {
	// EventCenter.Stop intentionally does NOT close the bus —
	// the bus is owned by its creator and may be shared with
	// other consumers. This test pins that contract by closing
	// the bus explicitly and asserting the next Publish fails.
	bus := services.NewChannelEventBus(1)
	center := services.NewEventCenter(nil, bus, 1)
	center.Start()
	center.Stop()
	if err := bus.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := bus.Publish(&fakeEvent{typ: "task.created", id: "evt-after-stop"}); !errors.Is(err, services.ErrBusClosed) {
		t.Errorf("Publish after bus Close: err = %v, want ErrBusClosed", err)
	}
}

// ----------------------------------------------------------------------
// Requeue — the retry sweeper feeds re-enqueued jobs back
// through this method (plan §5 — "Retry sweeper ... re-enqueues
// when due").
// ----------------------------------------------------------------------

func TestEventCenter_Requeue_NilJobIsNoop(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	center := services.NewEventCenter(nil, bus, 1)
	if err := center.Requeue(nil); err != nil {
		t.Errorf("Requeue(nil) should return nil; got %v", err)
	}
}

func TestEventCenter_Requeue_ReturnsErrAfterStop(t *testing.T) {
	bus := services.NewChannelEventBus(1)
	defer bus.Close()
	center := services.NewEventCenter(nil, bus, 1)
	center.Start()
	center.Stop()
	err := center.Requeue(&services.DeliveryJob{DeliveryID: "del-1"})
	if !errors.Is(err, services.ErrBusClosed) {
		t.Errorf("Requeue after Stop: err = %v, want ErrBusClosed", err)
	}
}

// ----------------------------------------------------------------------
// Envelope rendering sanity check (plan §3.1).
// ----------------------------------------------------------------------

func TestEnvelope_RendersToExpectedShape(t *testing.T) {
	env := services.Envelope{
		ID:          "evt_01",
		Type:        "task.moved",
		OccurredAt:  time.Date(2026, 9, 13, 12, 34, 56, 0, time.UTC),
		DeliveredAt: time.Date(2026, 9, 13, 12, 34, 57, 0, time.UTC),
		Actor:       services.Actor{Type: "USER", ID: "u_abc", Nickname: "alice"},
		Board:       &services.BoardRef{ID: "b_1", Name: "Demo"},
		Data:        map[string]any{"taskId": "t_1"},
	}
	body, err := services.MarshalEnvelope(env)
	if err != nil {
		t.Fatalf("MarshalEnvelope: %v", err)
	}
	for _, want := range []string{
		`"id":"evt_01"`,
		`"type":"task.moved"`,
		`"occurredAt":"2026-09-13T12:34:56Z"`,
		`"deliveredAt":"2026-09-13T12:34:57Z"`,
		`"actor":{"type":"USER","id":"u_abc","nickname":"alice"}`,
		`"board":{"id":"b_1","name":"Demo"}`,
		`"data":{"taskId":"t_1"}`,
	} {
		if !contains(body, want) {
			t.Errorf("envelope JSON missing %q in: %s", want, string(body))
		}
	}
}

func TestEnvelope_BoardOmittedWhenNil(t *testing.T) {
	env := services.Envelope{
		ID:         "evt_01",
		Type:       "board.created",
		OccurredAt: time.Now().UTC(),
		Data:       map[string]any{"boardId": "b_1"},
	}
	body, err := services.MarshalEnvelope(env)
	if err != nil {
		t.Fatalf("MarshalEnvelope: %v", err)
	}
	if contains(body, `"board":`) {
		t.Errorf("envelope for board-level event should omit board; got %s", string(body))
	}
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

// waitForJobs polls the recorder's WaitGroup until it
// reaches zero or the deadline expires. Returns true on
// success.
func waitForJobs(wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// contains is a tiny substring helper so the envelope test
// doesn't have to import strings for one use.
func contains(haystack []byte, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if string(haystack[i:i+len(needle)]) == needle {
			return true
		}
	}
	return false
}

// Compile-time guards: when go.mod / migrations shift these
// constants may be renamed; the test build fails loudly
// instead of silently drifting.
var (
	_ = services.DefaultWorkerCount
	_ = os.Getenv
)
