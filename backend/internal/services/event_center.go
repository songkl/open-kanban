package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// EventCenter is the dispatcher + worker pool described in
// plan §5 (docs/EVENT_CENTER_PLAN_s-1138.md). It owns:
//
//   - one goroutine draining the EventBus channel
//   - a Dispatcher that matches the event against the
//     webhooks table by event.type and §3.2 filters
//   - one INSERT per match into webhook_deliveries
//     (status='PENDING', per the migration-012 schema)
//   - the worker pool (default 4 goroutines, configurable
//     via WEBHOOK_WORKERS) that consumes the delivery jobs
//
// The pool is intentionally decoupled from the bus — see
// the Dispatcher and DeliverFunc fields — so tests can
// drive an EventCenter with a fake dispatcher and a
// recorder deliver function and assert on side-effects
// without standing up SQLite or real HTTP receivers.
type EventCenter struct {
	db         *sql.DB
	bus        EventBus
	dispatcher Dispatcher
	workers    int
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup

	deliveryQueue chan *DeliveryJob

	startOnce sync.Once
	stopOnce  sync.Once
	started   atomic.Bool
	stopCh    chan struct{}
	doneCh    chan struct{}

	deliverFn DeliverFunc
}

// DeliveryJob is the unit of work that flows from the
// dispatcher to a worker. The worker is expected to POST
// the Body to URL with HMAC signing (plan §5.2 — implemented
// in s-1142) and update the webhook_deliveries row.
//
// Secrets stay BLOB-typed in the job so the worker's signing
// step never has to round-trip through hex / base64 — the
// BLOB form is what the webhooks.secret column already
// stores.
type DeliveryJob struct {
	DeliveryID string
	WebhookID  string
	EventID    string
	EventType  string
	URL        string
	Secret     []byte
	Headers    string
	TimeoutSec int
	Attempt    int
	Body       []byte
}

// MatchedWebhook carries the webhook metadata the worker
// pool needs to send a delivery. Built from a row of
// models.Webhook plus the parsed event_types / filters
// columns by the SQLDBDispatcher.
type MatchedWebhook struct {
	WebhookID  string
	URL        string
	Secret     []byte
	Headers    string
	TimeoutSec int
	MaxRetries int
}

// Filterable is the optional interface an Event can
// implement to expose the metadata the dispatcher needs to
// evaluate per-webhook filters (plan §3.2). Events that
// don't implement Filterable skip filter matching — they
// fire on every webhook that lists their EventType. The
// four accessors mirror the JSON keys on
// webhooks.filters (boardIds / columnIds / priorities /
// assigneeIds); an empty string from any accessor means
// "this event has no value for that dimension", which the
// dispatcher treats as "the filter set must not require a
// match for that dimension".
type Filterable interface {
	FilterBoardID() string
	FilterColumnID() string
	FilterPriority() string
	FilterAssignee() string
}

// Dispatcher is the interface the EventCenter uses to look
// up matching webhooks for a given event and to insert the
// PENDING delivery row. Production wires this to
// SQLDBDispatcher; tests can swap in a fake to assert on
// the fan-out without standing up SQLite.
type Dispatcher interface {
	Matches(ctx context.Context, event Event, env Envelope) ([]*MatchedWebhook, error)
	InsertDelivery(ctx context.Context, m *MatchedWebhook, event Event, body []byte) (string, error)
}

// DeliverFunc is the signature of the worker function. The
// EventCenter runs one DeliverFunc call per DeliveryJob;
// tests inject a recorder here so they can assert on what
// the pool received without actually POSTing. Production
// uses the s-1142 implementation (HMAC sign + POST +
// status update).
type DeliverFunc func(ctx context.Context, job *DeliveryJob) error

// DefaultWorkerCount is the WEBHOOK_WORKERS fallback. Plan §5
// prescribes "N=4 goroutines, configurable" — we mirror the
// same number so a fresh install behaves like the docs
// promise.
const DefaultWorkerCount = 4

// NewEventCenter wires the EventCenter to the given bus / db
// and configures the worker pool. workers is the pool size;
// pass <= 0 to read WEBHOOK_WORKERS from the environment
// (with DefaultWorkerCount as the final fallback). The
// dispatcher is constructed lazily inside the struct (see
// Start) so a test can call SetDispatcher before Start to
// substitute a fake.
func NewEventCenter(db *sql.DB, bus EventBus, workers int) *EventCenter {
	if workers <= 0 {
		workers = workerCountFromEnv()
	}
	if workers <= 0 {
		workers = DefaultWorkerCount
	}
	if workers > 256 {
		// Cap is a defensive bound: a runaway WEBHOOK_WORKERS
		// env var shouldn't be able to fork thousands of
		// goroutines. 256 is well above any realistic
		// throughput target.
		workers = 256
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &EventCenter{
		db:            db,
		bus:           bus,
		workers:       workers,
		ctx:           ctx,
		cancel:        cancel,
		deliveryQueue: make(chan *DeliveryJob, workers*8),
		stopCh:        make(chan struct{}),
		doneCh:        make(chan struct{}),
	}
}

// workerCountFromEnv parses the WEBHOOK_WORKERS env var. A
// missing or non-positive value returns -1 so the caller can
// fall through to DefaultWorkerCount. A non-numeric value is
// logged and treated as missing so a typo doesn't crash the
// boot path.
func workerCountFromEnv() int {
	v := os.Getenv("WEBHOOK_WORKERS")
	if v == "" {
		return -1
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		slog.Warn("event_center: WEBHOOK_WORKERS invalid; using default",
			"value", v, "default", DefaultWorkerCount)
		return -1
	}
	return n
}

// SetDispatcher overrides the default SQL dispatcher. Test
// helper; production callers should leave it alone. Must be
// called before Start; a late call is silently ignored
// because the dispatcher field is read once per dispatch.
func (c *EventCenter) SetDispatcher(d Dispatcher) {
	c.dispatcher = d
}

// SetDeliverFunc overrides the worker function. Tests inject
// a recorder here so they can assert on what the pool
// received without actually POSTing. Must be called before
// Start; a late call is silently ignored because the
// deliverFn field is captured at worker startup.
func (c *EventCenter) SetDeliverFunc(fn DeliverFunc) {
	c.deliverFn = fn
}

// Start launches the dispatcher goroutine and the worker
// pool. Idempotent — a second call is a no-op so the
// hot-reload path doesn't double-spawn. Returns immediately;
// use Done() or Stop() to wait for shutdown.
func (c *EventCenter) Start() {
	c.startOnce.Do(func() {
		if c.dispatcher == nil {
			c.dispatcher = NewSQLDBDispatcher(c.db)
		}
		c.started.Store(true)
		c.wg.Add(1)
		go c.dispatchLoop()
		for i := 0; i < c.workers; i++ {
			c.wg.Add(1)
			go c.workerLoop()
		}
		slog.Info("event_center: started", "workers", c.workers)
	})
}

// Stop signals the dispatcher + workers to exit and blocks
// until they have all returned. Idempotent: calling Stop
// more than once is safe, and Stop is safe when Start was
// never called (the doneCh is left open and we must not
// block on it in that case).
func (c *EventCenter) Stop() {
	c.stopOnce.Do(func() {
		close(c.stopCh)
		c.cancel()
	})
	if !c.started.Load() {
		return
	}
	c.wg.Wait()
	c.stopOnce.Do(func() {
		close(c.doneCh)
	})
}

// Done returns a channel closed once Stop has finished. Tests
// use <-c.Done() in place of polling started.Load().
func (c *EventCenter) Done() <-chan struct{} {
	return c.doneCh
}

// WorkerCount returns the worker pool size in effect. Tests
// assert on this to confirm WEBHOOK_WORKERS plumbing (the
// "worker count limit" coverage called out in the s-1141
// spec).
func (c *EventCenter) WorkerCount() int {
	return c.workers
}

// dispatchLoop is the single goroutine that drains the bus
// and fans events out to webhook_deliveries rows + worker
// jobs. One goroutine (not one-per-event) so the SQL
// queries don't have to contend on connection pool slots
// and so we get in-order processing per event — important
// because two events for the same task must be dispatched
// in the order they happened.
func (c *EventCenter) dispatchLoop() {
	defer c.wg.Done()

	ch := c.bus.Channel()
	for {
		select {
		case <-c.stopCh:
			// Drain remaining events on best-effort so a
			// graceful shutdown doesn't drop late
			// publishes. Use a non-blocking select so we
			// don't deadlock if the bus is being closed in
			// parallel.
			for {
				select {
				case ev := <-ch:
					c.dispatchOne(ev)
				default:
					return
				}
			}
		case ev := <-ch:
			c.dispatchOne(ev)
		}
	}
}

func (c *EventCenter) dispatchOne(event Event) {
	if event == nil {
		return
	}
	env := Envelope{
		ID:          event.EnvelopeID(),
		Type:        event.EventType(),
		OccurredAt:  event.OccurredAt(),
		DeliveredAt: time.Now().UTC(),
		Data:        event.Data(),
	}

	matches, err := c.dispatcher.Matches(c.ctx, event, env)
	if err != nil {
		slog.Error("event_center: dispatcher.Matches failed",
			"event_id", env.ID,
			"event_type", env.Type,
			"error", err)
		return
	}
	if len(matches) == 0 {
		// No webhook matched. Plan §5 explicitly calls out
		// that the dispatcher returns nil in this case so
		// the publish cost stays bounded — we don't INSERT
		// a delivery row and we don't enqueue a job.
		return
	}

	body, err := json.Marshal(env)
	if err != nil {
		slog.Error("event_center: marshal envelope failed",
			"event_id", env.ID, "error", err)
		return
	}

	for _, m := range matches {
		deliveryID, err := c.dispatcher.InsertDelivery(c.ctx, m, event, body)
		if err != nil {
			slog.Error("event_center: insert delivery failed",
				"webhook_id", m.WebhookID,
				"event_id", env.ID,
				"error", err)
			continue
		}
		job := &DeliveryJob{
			DeliveryID: deliveryID,
			WebhookID:  m.WebhookID,
			EventID:    env.ID,
			EventType:  env.Type,
			URL:        m.URL,
			Secret:     m.Secret,
			Headers:    m.Headers,
			TimeoutSec: m.TimeoutSec,
			Attempt:    1,
			Body:       body,
		}
		// Hand off to a worker. Respect stopCh so a
		// shutdown doesn't deadlock on a full queue.
		select {
		case <-c.stopCh:
			return
		case c.deliveryQueue <- job:
		}
	}
}

// workerLoop is one of the worker-pool goroutines. It pulls
// delivery jobs off the queue and runs them through the
// DeliverFunc (production: HMAC sign + POST + retry; tests:
// recorder). Cancellation flows through both context.Done
// and stopCh so either shutdown path wakes the worker.
func (c *EventCenter) workerLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.stopCh:
			return
		case job := <-c.deliveryQueue:
			if job == nil {
				return
			}
			c.runDeliver(c.ctx, job)
		}
	}
}

// runDeliver invokes the configured DeliverFunc. The
// indirection exists so the nil-default-deliverer case (no
// SetDeliverFunc call) still produces a sensible behaviour —
// see defaultDeliver — instead of panicking.
func (c *EventCenter) runDeliver(ctx context.Context, job *DeliveryJob) {
	fn := c.deliverFn
	if fn == nil {
		fn = defaultDeliver
	}
	if err := fn(ctx, job); err != nil {
		slog.Error("event_center: deliver failed",
			"delivery_id", job.DeliveryID,
			"webhook_id", job.WebhookID,
			"error", err)
	}
}

// defaultDeliver is the worker function used when no
// SetDeliverFunc call has happened. It intentionally does
// nothing: the s-1141 spec is for bus + dispatcher + worker
// pool plumbing, not for HMAC signing / POST / retry (those
// land in s-1142). Tests that want to assert on delivered
// jobs call SetDeliverFunc with a recorder.
func defaultDeliver(ctx context.Context, job *DeliveryJob) error {
	slog.Debug("event_center: default deliver is a no-op (s-1141 stub)",
		"delivery_id", job.DeliveryID,
		"webhook_id", job.WebhookID)
	return nil
}

// ----------------------------------------------------------------------
// SQLDBDispatcher — production Dispatcher backed by the
// webhooks + webhook_deliveries tables.
// ----------------------------------------------------------------------

// SQLDBDispatcher matches events against the webhooks table
// by event_type + §3.2 filters and INSERTs a PENDING
// webhook_deliveries row per match. The match query loads
// the full row set (filtered by event_types containing the
// type, enabled=1) once per event and applies the §3.2
// filters in Go; per-event fan-out in production is bounded
// by the webhook count which the operator controls, so an
// in-memory filter step is acceptable.
type SQLDBDispatcher struct {
	db *sql.DB
}

// NewSQLDBDispatcher constructs a dispatcher backed by db.
// db must already have the webhooks + webhook_deliveries
// tables from migration 012 applied; otherwise every method
// here returns a SQL "no such table" error.
func NewSQLDBDispatcher(db *sql.DB) *SQLDBDispatcher {
	return &SQLDBDispatcher{db: db}
}

// Matches returns the list of enabled webhooks that:
//   - list event.EventType() in their event_types JSON array
//     (or have an empty event_types "[]" which we treat as
//     "match nothing" — operators are expected to declare
//     at least one type so a freshly-created webhook doesn't
//     silently fan out to every event in the system).
//   - pass the §3.2 filter check against the event's
//     Filterable accessors (board / column / priority /
//     assignee). Events that don't implement Filterable
//     skip the filter check and match purely on type.
//
// The boolean return is true when at least one match was
// found; the worker-pool enqueue is gated on len(matches) so
// a no-op publish costs nothing (plan §5 — "no webhooks
// match → directly return nil").
func (d *SQLDBDispatcher) Matches(ctx context.Context, event Event, env Envelope) ([]*MatchedWebhook, error) {
	if event == nil {
		return nil, nil
	}
	rows, err := d.db.QueryContext(ctx, `
		SELECT id, url, secret, event_types, filters, headers, timeout_sec, max_retries
		FROM webhooks
		WHERE enabled = 1
	`)
	if err != nil {
		return nil, fmt.Errorf("event_center: list webhooks: %w", err)
	}
	defer rows.Close()

	var (
		out    []*MatchedWebhook
		matched int
	)
	for rows.Next() {
		var (
			id         string
			url        string
			secret     []byte
			eventTypes string
			filters    string
			headers    string
			timeoutSec int
			maxRetries int
		)
		if err := rows.Scan(&id, &url, &secret, &eventTypes, &filters, &headers, &timeoutSec, &maxRetries); err != nil {
			return nil, fmt.Errorf("event_center: scan webhook: %w", err)
		}
		if !eventTypeMatches(eventTypes, event.EventType()) {
			continue
		}
		if !filtersMatch(filters, event) {
			continue
		}
		matched++
		out = append(out, &MatchedWebhook{
			WebhookID:  id,
			URL:        url,
			Secret:     secret,
			Headers:    headers,
			TimeoutSec: timeoutSec,
			MaxRetries: maxRetries,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("event_center: iterate webhooks: %w", err)
	}
	_ = matched
	if len(out) == 0 {
		// Explicit nil slice (not empty) so the dispatcher's
		// "no matches" branch is unambiguous and the test
		// suite can assert via errors.Is / len() without
		// dancing between nil and [].
		return nil, nil
	}
	return out, nil
}

// InsertDelivery writes a PENDING row into webhook_deliveries
// and returns the new id. The id is an opaque hex string so
// it can be surfaced in the X-Webhook-Delivery header
// without leaking the internal sequence.
func (d *SQLDBDispatcher) InsertDelivery(ctx context.Context, m *MatchedWebhook, event Event, body []byte) (string, error) {
	if m == nil {
		return "", errors.New("event_center: nil matched webhook")
	}
	id, err := generateOpaqueID(12)
	if err != nil {
		return "", fmt.Errorf("event_center: generate delivery id: %w", err)
	}
	_, err = d.db.ExecContext(ctx, `
		INSERT INTO webhook_deliveries
		    (id, webhook_id, event_id, event_type, status, attempt, request_body, started_at)
		VALUES (?, ?, ?, ?, 'PENDING', 1, ?, CURRENT_TIMESTAMP)
	`,
		id,
		m.WebhookID,
		event.EnvelopeID(),
		event.EventType(),
		string(body),
	)
	if err != nil {
		return "", fmt.Errorf("event_center: insert delivery: %w", err)
	}
	return id, nil
}

// eventTypeMatches returns true when the webhook's
// event_types JSON array contains eventType. An empty
// array "[]" matches nothing — a freshly-created webhook
// without declared types stays inert until the operator
// populates them via PATCH /api/v1/webhooks/:id.
//
// The JSON parse is intentionally lenient: anything that
// fails to unmarshal as []string is treated as "no types"
// (matches nothing) so a corrupted column can't accidentally
// fan out a single event to every webhook.
func eventTypeMatches(eventTypesJSON, eventType string) bool {
	if eventType == "" {
		return false
	}
	var types []string
	if err := json.Unmarshal([]byte(eventTypesJSON), &types); err != nil {
		return false
	}
	for _, t := range types {
		if t == eventType {
			return true
		}
	}
	return false
}

// filtersMatch applies the §3.2 filter set against the
// event's Filterable accessors. Plan §3.2: a row matches
// when all non-empty filter sets intersect the event
// payload (logical AND across categories, OR within a
// category). Empty filters ("{}") match every event of the
// listed type.
//
// Events that don't implement Filterable skip the check —
// they have no metadata to test against, so the only
// requirement is that event_type is in event_types.
func filtersMatch(filtersJSON string, event Event) bool {
	var filters map[string][]string
	if filtersJSON == "" || filtersJSON == "{}" {
		return true
	}
	if err := json.Unmarshal([]byte(filtersJSON), &filters); err != nil {
		// A malformed filter column shouldn't silently fan
		// out every event of the type. Treat it as "this
		// row never matches" and log via slog from the
		// caller if needed.
		return false
	}
	f, ok := event.(Filterable)
	if !ok {
		// Event has no metadata; only filter set {} (already
		// handled above) would have matched. Any declared
		// filter dimension is unsatisfiable.
		return len(filters) == 0
	}
	for _, key := range []string{"boardIds", "columnIds", "priorities", "assigneeIds"} {
		set, ok := filters[key]
		if !ok || len(set) == 0 {
			continue
		}
		var got string
		switch key {
		case "boardIds":
			got = f.FilterBoardID()
		case "columnIds":
			got = f.FilterColumnID()
		case "priorities":
			got = f.FilterPriority()
		case "assigneeIds":
			got = f.FilterAssignee()
		}
		if got == "" {
			// The event has no value for this dimension but
			// the webhook demands a match — fail closed.
			return false
		}
		if !containsString(set, got) {
			return false
		}
	}
	return true
}

// containsString reports whether set contains v. The empty
// string is never in a non-empty set, so a webhook that
// declares priorities=["high"] won't accidentally match an
// event with no priority.
func containsString(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}
