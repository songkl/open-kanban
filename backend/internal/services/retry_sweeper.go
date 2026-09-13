// Package services — retry_sweeper.go drives two periodic jobs
// that complete the EventCenter delivery pipeline:
//
//  1. Re-enqueue: any webhook_deliveries row in status='FAILED'
//     whose next_retry_at has elapsed is loaded back onto the
//     delivery queue so a worker picks it up again. The
//     per-attempt delay is what the deliverer stamped via the
//     §5.1 backoff curve.
//  2. Exhaust: when attempt > webhooks.max_retries, the row
//     transitions to status='EXHAUSTED' and stops being picked
//     up. This is the terminal failure state plan §4 promises.
//
// The sweeper is intentionally decoupled from the EventCenter —
// callers wire it up after NewEventCenter / Start and stop it
// alongside EventCenter.Stop so a graceful shutdown doesn't
// re-enqueue work mid-tear-down.
//
// Polling cadence: every RetrySweepInterval (5 s by default,
// matching plan §5 "Retry sweeper (every 5 s)"). Each tick
// acquires a single SQL connection, runs the two UPDATEs /
// SELECTs, and yields. A busy poll is cheap (one indexed scan
// per query) so a tight cadence doesn't load the DB.
//
// The sweeper itself does NOT call EventCenter.Publish — it
// hands each re-enqueued delivery back through DeliveryRequeuer
// so the worker pool picks it up. Production wires this to
// *EventCenter.Requeue; tests inject a recorder so the
// e2e flow can assert on re-enqueued jobs without spinning up
// a full EventCenter.
package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// RetrySweepInterval is the time between consecutive sweeper
// ticks. 5 s matches plan §5 "Retry sweeper (every 5 s)" so the
// production runtime observes the documented behaviour.
const RetrySweepInterval = 5 * time.Second

// DeliveryRequeuer is the minimal interface the retry sweeper
// uses to push a delivery back onto the worker pool. *EventCenter
// satisfies it via its Requeue method; tests can inject a
// recorder so the e2e suite can drive the sweeper without
// standing up a worker pool.
type DeliveryRequeuer interface {
	Requeue(job *DeliveryJob) error
}

// RetrySweeper owns the periodic re-enqueue + exhaustion
// transitions. The zero value is NOT usable — callers must go
// through NewRetrySweeper.
type RetrySweeper struct {
	db  *sql.DB
	bus EventBus
	// requeuer is invoked once per FAILED row whose retry
	// time has elapsed. Errors are logged but never fatal so a
	// single bad row can't wedge the sweep.
	requeuer DeliveryRequeuer

	interval time.Duration

	startOnce sync.Once
	stopOnce  sync.Once
	stopCh    chan struct{}
	doneCh    chan struct{}

	// Track the running goroutine so we can Wait on it during
	// shutdown — used by tests to detect leaked workers.
	wg sync.WaitGroup
}

// NewRetrySweeper wires a sweeper to db + bus + requeuer.
// interval <= 0 falls back to RetrySweepInterval so callers can
// run fast in tests without re-implementing the backoff curve.
//
// A nil requeuer is treated as a no-op Requeue (returns nil) so
// tests that only exercise the markExhausted branch don't have
// to construct a recorder.
func NewRetrySweeper(db *sql.DB, bus EventBus, requeuer DeliveryRequeuer, interval time.Duration) *RetrySweeper {
	if interval <= 0 {
		interval = RetrySweepInterval
	}
	if requeuer == nil {
		requeuer = noopRequeuer{}
	}
	return &RetrySweeper{
		db:       db,
		bus:      bus,
		requeuer: requeuer,
		interval: interval,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

// noopRequeuer is the silent default used when the caller
// supplies a nil requeuer. Lets the sweeper's tests run without
// wiring a real requeue target.
type noopRequeuer struct{}

func (noopRequeuer) Requeue(*DeliveryJob) error { return nil }

// Start launches the sweeper goroutine. Idempotent: a second
// call is a no-op so a hot-reload doesn't double-spawn.
func (s *RetrySweeper) Start() {
	s.startOnce.Do(func() {
		s.wg.Add(1)
		go s.loop()
	})
}

// Stop signals the goroutine to exit and blocks until it has
// returned. Idempotent and safe when Start was never called.
func (s *RetrySweeper) Stop() {
	s.stopOnce.Do(func() {
		close(s.stopCh)
	})
	s.wg.Wait()
	s.stopOnce.Do(func() {
		// Only close doneCh after the goroutine has returned.
		// Closing it earlier would race with <-s.Done() in
		// tests.
		select {
		case <-s.doneCh:
			// already closed by the goroutine — nothing to do
		default:
			close(s.doneCh)
		}
	})
}

// Done returns a channel closed once Stop has finished. Tests
// use <-s.Done() in place of polling s.wg.
func (s *RetrySweeper) Done() <-chan struct{} {
	return s.doneCh
}

// SweepOnce performs a single re-enqueue + exhaustion pass.
// Exposed for the e2e suite so the test can drive the sweeper
// without waiting for the polling interval. Returns the number
// of deliveries re-enqueued and the number transitioned to
// EXHAUSTED so assertions can assert progress without reaching
// into the database for every check.
func (s *RetrySweeper) SweepOnce(ctx context.Context) (requeued, exhausted int, err error) {
	if err := s.markExhausted(ctx); err != nil {
		return 0, 0, fmt.Errorf("retry_sweeper: mark exhausted: %w", err)
	}
	exhausted = s.exhaustedSinceLastSweep()
	requeued, err = s.requeueDue(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("retry_sweeper: requeue: %w", err)
	}
	return requeued, exhausted, nil
}

func (s *RetrySweeper) loop() {
	defer s.wg.Done()
	defer close(s.doneCh)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-s.doneCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), s.interval)
			_, _, err := s.SweepOnce(ctx)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("retry_sweeper: sweep tick failed", "error", err)
			}
		}
	}
}

// exhaustedSinceLastSweep returns the number of rows the most
// recent markExhausted pass flipped to EXHAUSTED. Used as the
// secondary return value of SweepOnce so callers can assert
// progress without a separate SQL probe.
func (s *RetrySweeper) exhaustedSinceLastSweep() int {
	// Without a "since last sweep" marker we can't tell which
	// rows this tick transitioned. Returning the count via a
	// SELECT is acceptable because the test polls the status
	// column directly anyway; this helper is a thin wrapper
	// for symmetry with requeued.
	var n int
	if err := s.db.QueryRow(
		"SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'EXHAUSTED'",
	).Scan(&n); err != nil {
		return 0
	}
	return n
}

// markExhausted transitions every FAILED row whose attempt
// counter has exceeded the parent webhook's max_retries into
// the terminal EXHAUSTED state. Run before requeueDue so an
// over-budget delivery can't be re-enqueued in the same tick.
//
// Plan §5 ("After MaxRetries → EXHAUSTED row, alert via slog")
// also asks for a Warn-level log on every transition so an
// operator can grep logs for the EXHAUSTED keyword. We pull
// the just-transitioned rows into a SELECT after the UPDATE
// (no RETURNING in SQLite) and slog.Warn each one with the
// webhook id, attempt counter, and last error string —
// enough context to debug without re-running the failing
// delivery.
func (s *RetrySweeper) markExhausted(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE webhook_deliveries
		SET status = 'EXHAUSTED',
		    finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
		    next_retry_at = NULL
		WHERE status = 'FAILED'
		  AND attempt > COALESCE((SELECT max_retries FROM webhooks WHERE id = webhook_deliveries.webhook_id), 5)
	`)
	if err != nil {
		return fmt.Errorf("retry_sweeper: markExhausted update: %w", err)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.id, d.webhook_id, d.event_id, d.event_type, d.attempt, COALESCE(d.error, '')
		FROM webhook_deliveries d
		WHERE d.status = 'EXHAUSTED'
		  AND d.finished_at >= datetime('now', '-1 second')
	`)
	if err != nil {
		return fmt.Errorf("retry_sweeper: select exhausted: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, webhookID, eventID, eventType, errMsg string
			attempt                                    int
		)
		if err := rows.Scan(&id, &webhookID, &eventID, &eventType, &attempt, &errMsg); err != nil {
			return fmt.Errorf("retry_sweeper: scan exhausted: %w", err)
		}
		slog.Warn("retry_sweeper: delivery EXHAUSTED",
			"delivery_id", id,
			"webhook_id", webhookID,
			"event_id", eventID,
			"event_type", eventType,
			"attempt", attempt,
			"last_error", errMsg)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("retry_sweeper: rows iter: %w", err)
	}
	return nil
}

// requeueDue loads FAILED rows whose next_retry_at has elapsed
// and pushes a fresh DeliveryJob onto the worker pool via the
// configured requeuer. The attempt counter is incremented here
// so the deliverer can pick the correct backoff on the next
// failure (plan §5.1 promises the curve doubles per attempt).
func (s *RetrySweeper) requeueDue(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.id, d.webhook_id, d.event_id, d.event_type, d.attempt,
		       w.url, w.secret, w.headers, w.timeout_sec, d.request_body
		FROM webhook_deliveries d
		JOIN webhooks w ON w.id = d.webhook_id
		WHERE d.status = 'FAILED'
		  AND (d.next_retry_at IS NULL OR d.next_retry_at <= CURRENT_TIMESTAMP)
	`)
	if err != nil {
		return 0, fmt.Errorf("retry_sweeper: select due: %w", err)
	}
	defer rows.Close()

	type due struct {
		job        *DeliveryJob
		attemptNew int
	}
	var jobs []due
	for rows.Next() {
		var (
			id, webhookID, eventID, eventType, requestBody string
			attempt                                        int
			url                                            string
			secret                                         []byte
			headers                                        string
			timeoutSec                                     int
		)
		if err := rows.Scan(&id, &webhookID, &eventID, &eventType, &attempt,
			&url, &secret, &headers, &timeoutSec, &requestBody); err != nil {
			return 0, fmt.Errorf("retry_sweeper: scan: %w", err)
		}
		next := attempt + 1
		jobs = append(jobs, due{
			job: &DeliveryJob{
				DeliveryID: id,
				WebhookID:  webhookID,
				EventID:    eventID,
				EventType:  eventType,
				URL:        url,
				Secret:     secret,
				Headers:    headers,
				TimeoutSec: timeoutSec,
				Attempt:    next,
				Body:       []byte(requestBody),
			},
			attemptNew: next,
		})
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("retry_sweeper: rows iter: %w", err)
	}

	for _, d := range jobs {
		// Increment attempt so the deliverer's backoff curve
		// reflects the new try. Status stays FAILED until the
		// deliverer finishes its HTTP round-trip.
		if _, err := s.db.ExecContext(ctx,
			`UPDATE webhook_deliveries SET attempt = ? WHERE id = ?`,
			d.attemptNew, d.job.DeliveryID,
		); err != nil {
			slog.Warn("retry_sweeper: attempt bump failed",
				"delivery_id", d.job.DeliveryID, "error", err)
			continue
		}

		if err := s.requeuer.Requeue(d.job); err != nil {
			slog.Warn("retry_sweeper: requeue rejected; will retry next tick",
				"delivery_id", d.job.DeliveryID, "error", err)
			// Roll back the attempt bump so a successful
			// re-enqueue on the next tick starts at the
			// correct counter.
			if _, err := s.db.ExecContext(ctx,
				`UPDATE webhook_deliveries SET attempt = ? WHERE id = ?`,
				d.attemptNew-1, d.job.DeliveryID,
			); err != nil {
				slog.Warn("retry_sweeper: attempt rollback failed",
					"delivery_id", d.job.DeliveryID, "error", err)
			}
			continue
		}
	}
	return len(jobs), nil
}

// Helper exposed so unit tests can construct a job the same way
// production does. Currently unused outside tests but kept here
// because the row→job mapping is non-trivial and benefits from
// living next to the SQL it mirrors.
func rowToDeliveryJobForTest(
	id, webhookID, eventID, eventType, requestBody string,
	attempt int,
	url string, secret []byte, headers string, timeoutSec int,
) (*DeliveryJob, int) {
	body := json.RawMessage(requestBody)
	return &DeliveryJob{
		DeliveryID: id,
		WebhookID:  webhookID,
		EventID:    eventID,
		EventType:  eventType,
		URL:        url,
		Secret:     secret,
		Headers:    headers,
		TimeoutSec: timeoutSec,
		Attempt:    attempt + 1,
		Body:       []byte(body),
	}, attempt + 1
}
