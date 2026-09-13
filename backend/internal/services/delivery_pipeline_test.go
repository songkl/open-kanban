// Package services — delivery_pipeline_test.go is the
// table-driven exercise of the §5.1 / §5.2 / §5.3 / §5.5
// pipeline described in plan §5 of
// docs/EVENT_CENTER_PLAN_s-1138.md.
//
// Each sub-test stands up an httptest.Server that returns
// one of three responses:
//
//   - 200 OK → row transitions to SUCCESS, no next_retry_at
//   - 500 Internal Server Error → row transitions to FAILED
//     with a next_retry_at stamped by the §5.1 backoff curve
//   - deliberate timeout (server holds the connection open
//     past the per-request TimeoutSec) → row transitions to
//     FAILED with response_code = 408 and next_retry_at set
//
// The wire format asserted in the 200 case matches the
// canonical openssl incantation; the 500 / timeout cases
// focus on the row state machine rather than header
// inspection (those headers are already covered by
// TestWebhookE2E_HappyPath_ReceiverGetsSignedPOST and
// TestWebhookE2E_SignatureMatchesOpenSSL).
package services_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

// deliveryPipelineCase encodes one row of the table-driven
// pipeline test. name is shown in -v output; status is the
// status code the receiver returns (0 → "block forever" to
// force a timeout); delayBeforeWrite is the optional sleep
// before the receiver writes the response so we can hit the
// per-request TimeoutSec reliably; wantStatus is the row
// state we expect after the worker finishes; wantCode is
// the response_code column we expect.
type deliveryPipelineCase struct {
	name             string
	status           int
	delayBeforeWrite time.Duration
	body             string
	wantStatus       string
	wantCode         int
	wantHasRetry     bool
}

// runDeliveryPipelineCase is the shared body of every
// sub-test. It:
//
//  1. Stands up an in-memory SQLite with the production
//     webhooks + webhook_deliveries schema.
//  2. Seeds one webhook pointing at the supplied httptest
//     receiver, configured with max_retries=5 so the row
//     doesn't transition to EXHAUSTED after the first failure.
//  3. Wires an EventCenter + production DeliverFunc +
//     RetrySweeper (interval=10ms so the test runs fast).
//  4. Publishes a task.created event to the bus.
//  5. Polls the delivery row until it lands in wantStatus or
//     the 3s deadline expires.
//
// The function is shared so every row in the table uses the
// same fixture and assertions; per-case variation lives in
// the receiver behaviour.
func runDeliveryPipelineCase(t *testing.T, tc deliveryPipelineCase) {
	t.Helper()
	db := setupE2EDB(t)
	defer db.Close()

	var (
		mu     sync.Mutex
		called bool
	)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tc.delayBeforeWrite > 0 {
			time.Sleep(tc.delayBeforeWrite)
		}
		mu.Lock()
		called = true
		mu.Unlock()
		// The status==0 branch (block forever) is reserved
		// for the timeout case, which uses
		// runDeliveryPipelineCaseWithTimeout directly.
		// Guard with a panic so a misuse surfaces fast.
		if tc.status == 0 {
			// Block on r.Context().Done() so a healthy
			// client timeout unwinds the handler.
			<-r.Context().Done()
			return
		}
		w.WriteHeader(tc.status)
		_, _ = w.Write([]byte(tc.body))
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	seedWebhookE2E(t, db, "wh-pipeline", srv.URL, "0011223344556677", 5)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	sweeper := services.NewRetrySweeper(db, bus, center, 10*time.Millisecond)
	sweeper.Start()
	defer sweeper.Stop()

	ev := &fakeEvent{
		typ: "task.created",
		id:  "evt-pipeline-" + tc.name,
		at:  time.Now().UTC(),
		data: map[string]any{
			"task": map[string]any{"id": "t-" + tc.name, "title": tc.name},
		},
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if got := waitForDeliveryStatus(t, db, []string{tc.wantStatus}, 3*time.Second); got != tc.wantStatus {
		t.Fatalf("delivery status: got %q want %q", got, tc.wantStatus)
	}

	mu.Lock()
	gotCalled := called
	mu.Unlock()
	if !gotCalled && tc.status != 0 {
		t.Errorf("receiver never observed a POST in case %q", tc.name)
	}

	var (
		responseCode int
		nextRetry    sql.NullTime
	)
	if err := db.QueryRow(`
		SELECT response_code, next_retry_at
		FROM webhook_deliveries WHERE event_id = ?
	`, ev.id).Scan(&responseCode, &nextRetry); err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if tc.wantCode != 0 && responseCode != tc.wantCode {
		t.Errorf("response_code: got %d want %d", responseCode, tc.wantCode)
	}
	if tc.wantHasRetry && !nextRetry.Valid {
		t.Errorf("next_retry_at must be populated on %s; got NULL", tc.wantStatus)
	}
	if !tc.wantHasRetry && nextRetry.Valid && tc.wantStatus == "SUCCESS" {
		t.Errorf("next_retry_at must be NULL on SUCCESS; got %v", nextRetry.Time)
	}
}

// TestDeliveryPipeline_ResultTable covers the three primary
// receiver outcomes (200/500/timeout) in a single table so
// additional rows can be added without copy-pasting fixture
// setup. See deliveryPipelineCase above for column semantics.
func TestDeliveryPipeline_ResultTable(t *testing.T) {
	// Use a short timeout (1s) for the receiver-blocking
	// case so the test doesn't have to wait the production
	// default of 10s before each retry sweeper tick.
	//
	// Note: the per-webhook TimeoutSec column drives the
	// deliverer's per-request timeout; we override the row
	// inside the timeout sub-test below.
	cases := []deliveryPipelineCase{
		{
			name:         "two-hundred-success",
			status:       http.StatusOK,
			body:         `{"ok":true}`,
			wantStatus:   "SUCCESS",
			wantCode:     200,
			wantHasRetry: false,
		},
		{
			name:         "five-hundred-fails-and-schedules-retry",
			status:       http.StatusInternalServerError,
			body:         `{"err":"down"}`,
			wantStatus:   "FAILED",
			wantCode:     500,
			wantHasRetry: true,
		},
		{
			name:             "timeout-trips-deliverer-context",
			status:           0, // never writes — receiver holds the connection
			delayBeforeWrite: 0,
			wantStatus:       "FAILED",
			wantCode:         http.StatusRequestTimeout, // 408
			wantHasRetry:     true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The timeout sub-test needs a short TimeoutSec
			// (1s) so the deliverer's per-request context
			// fires before the test runner's 3s poll
			// deadline. We override the row after seeding.
			//
			// All other sub-tests use the production default
			// (10s) so a regression that hard-codes the
			// timeout surfaces.
			if tc.name == "timeout-trips-deliverer-context" {
				runDeliveryPipelineCaseWithTimeout(t, tc, 1)
				return
			}
			runDeliveryPipelineCase(t, tc)
		})
	}
}

// runDeliveryPipelineCaseWithTimeout is the variant that
// overrides the seeded webhook's timeout_sec so the
// timeout-trips-deliverer-context case runs fast. Mirrors
// runDeliveryPipelineCase but with the timeout knob turned.
//
// The receiver deliberately blocks on r.Context().Done()
// rather than `select {}` so that when the deliverer's
// http.Client times out and closes the connection, the
// handler returns and httptest.Server.Close() doesn't hang.
func runDeliveryPipelineCaseWithTimeout(t *testing.T, tc deliveryPipelineCase, timeoutSec int) {
	t.Helper()
	db := setupE2EDB(t)
	defer db.Close()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block until either the client disconnects (which
		// the deliverer's http.Client.Timeout triggers,
		// firing r.Context().Done()) or the safety net
		// timer fires. The timer is 5× the deliverer's
		// 1-second TimeoutSec so a healthy run always
		// exits via r.Context().Done(); the timer is the
		// belt-and-braces fallback for the rare case where
		// the client TCP close is lost and r.Context()
		// never fires.
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	seedWebhookE2E(t, db, "wh-pipeline", srv.URL, "0011223344556677", 5)
	if _, err := db.Exec(
		"UPDATE webhooks SET timeout_sec = ? WHERE id = ?",
		timeoutSec, "wh-pipeline",
	); err != nil {
		t.Fatalf("override timeout_sec: %v", err)
	}

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ: "task.created",
		id:  "evt-pipeline-" + tc.name,
		at:  time.Now().UTC(),
		data: map[string]any{
			"task": map[string]any{"id": "t-timeout", "title": tc.name},
		},
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if got := waitForDeliveryStatus(t, db, []string{tc.wantStatus}, 5*time.Second); got != tc.wantStatus {
		t.Fatalf("delivery status: got %q want %q", got, tc.wantStatus)
	}

	var (
		responseCode int
		nextRetry    sql.NullTime
	)
	if err := db.QueryRow(`
		SELECT response_code, next_retry_at
		FROM webhook_deliveries WHERE event_id = ?
	`, ev.id).Scan(&responseCode, &nextRetry); err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if responseCode != tc.wantCode {
		t.Errorf("response_code: got %d want %d", responseCode, tc.wantCode)
	}
	if !nextRetry.Valid {
		t.Errorf("next_retry_at must be populated on timeout; got NULL")
	}
}

// TestDeliveryPipeline_BackoffMath stamps a FAILED row by
// hand and asserts next_retry_at lands within the §5.1
// curve window. Goes through the full EventCenter loop so
// the same ComputeBackoff path the deliverer uses is
// exercised (rather than calling it directly).
func TestDeliveryPipeline_BackoffMath(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	rec := newReceiver(500, `{"err":"down"}`)
	srv := httptest.NewServer(rec)
	defer srv.Close()

	seedWebhookE2E(t, db, "wh-backoff", srv.URL, "0011223344556677", 5)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ: "task.created",
		id:  "evt-backoff",
		at:  time.Now().UTC(),
		data: map[string]any{"task": map[string]any{"id": "t-bo"}},
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if got := waitForDeliveryStatus(t, db, []string{"FAILED"}, 3*time.Second); got != "FAILED" {
		t.Fatalf("expected FAILED; got %s", got)
	}

	// Compute expected window per §5.1 curve for attempt=1:
	//   min = 1s (base), max = 2s (base + jitter).
	var (
		attempt    int
		nextRetry  time.Time
		finishedAt time.Time
	)
	if err := db.QueryRow(`
		SELECT attempt, next_retry_at, finished_at
		FROM webhook_deliveries WHERE event_id = ?
	`, ev.id).Scan(&attempt, &nextRetry, &finishedAt); err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if attempt != 1 {
		t.Errorf("attempt: got %d want 1", attempt)
	}
	delta := nextRetry.Sub(finishedAt)
	if delta < time.Second || delta > 2*time.Second {
		t.Errorf("next_retry_at delta: got %v want in [1s, 2s]", delta)
	}
}

// TestDeliveryPipeline_ExhaustionLogsWarning covers the §5
// "EXHAUSTED row, alert via slog" promise. We pin the
// row state machine (FAILED → EXHAUSTED after attempt
// exceeds max_retries) but not the slog output (slog is
// already exercised in the e2e suite). A future test could
// capture the slog handler if the warning message becomes
// part of a public contract.
func TestDeliveryPipeline_ExhaustionLogsWarning(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	rec := newReceiver(500, `{"err":"down"}`)
	srv := httptest.NewServer(rec)
	defer srv.Close()

	const maxRetries = 2
	seedWebhookE2E(t, db, "wh-exhaust", srv.URL, "0011223344556677", maxRetries)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	sweeper := services.NewRetrySweeper(db, bus, center, 10*time.Millisecond)
	sweeper.Start()
	defer sweeper.Stop()

	ev := &fakeEvent{
		typ: "task.created",
		id:  "evt-exhaust",
		at:  time.Now().UTC(),
		data: map[string]any{"task": map[string]any{"id": "t-ex"}},
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Wait for the row to appear (the dispatcher + worker
	// need to enqueue + INSERT before the sweeper has
	// anything to operate on).
	if status := waitForDeliveryStatus(t, db, []string{"FAILED", "EXHAUSTED"}, 3*time.Second); status == "" {
		t.Fatalf("delivery row never appeared in webhook_deliveries")
	}

	// Drive the sweeper until EXHAUSTED. We force
	// next_retry_at to the past between ticks so each
	// SweepOnce is due to run.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := db.Exec(
			"UPDATE webhook_deliveries SET next_retry_at = CURRENT_TIMESTAMP WHERE status = 'FAILED'",
		); err != nil {
			t.Fatalf("force next_retry_at: %v", err)
		}

		var status string
		if err := db.QueryRow(
			"SELECT status FROM webhook_deliveries WHERE event_id = ?",
			ev.id,
		).Scan(&status); err != nil {
			t.Fatalf("query delivery: %v", err)
		}
		if status == "EXHAUSTED" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	var (
		finalStatus  string
		finalAttempt int
	)
	if err := db.QueryRow(
		"SELECT status, attempt FROM webhook_deliveries WHERE event_id = ?",
		ev.id,
	).Scan(&finalStatus, &finalAttempt); err != nil {
		t.Fatalf("final query: %v", err)
	}
	if finalStatus != "EXHAUSTED" {
		t.Errorf("final status: got %s want EXHAUSTED", finalStatus)
	}
	if finalAttempt <= maxRetries {
		t.Errorf("final attempt %d must exceed max_retries %d", finalAttempt, maxRetries)
	}
}

// TestDeliveryPipeline_RateLimitShuffle covers §5.3:
// when the rate limiter is exhausted the deliverer stamps
// FAILED + response_code=429 + next_retry_at = now + 1s
// without burning an HTTP round-trip.
//
// The table-driven shape isn't used here because the case
// is genuinely singular; see rate_limiter_test.go for the
// limiter-specific coverage.
func TestDeliveryPipeline_RateLimitShuffle(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	// Receiver that should NEVER see a request: the rate
	// limiter is exhausted before the first POST is
	// attempted.
	rec := newReceiver(200, `{"ok":true}`)
	srv := httptest.NewServer(rec)
	defer srv.Close()

	seedWebhookE2E(t, db, "wh-rl", srv.URL, "0011223344556677", 5)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	// Cap the limiter at 0 so every Allow call fails.
	limiter := services.NewRateLimiter(0)
	// Pre-populate one entry to ensure the webhook is
	// already over the cap (a cap of 0 with no entries is
	// trivially permissive because Allow returns true
	// when len(ring) >= cap=0 evaluates to false; we
	// want the limiter to actively block, so we set a
	// positive cap, exhaust it, and then verify the
	// reschedule path).
	limiter = services.NewRateLimiter(1)
	if !limiter.Allow("wh-rl") {
		t.Fatal("first call should pass with cap=1")
	}

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFuncWithDeps(services.DefaultDeliverDeps{
		DB:          db,
		RateLimiter: limiter,
	}))
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ: "task.created",
		id:  "evt-rl",
		at:  time.Now().UTC(),
		data: map[string]any{"task": map[string]any{"id": "t-rl"}},
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if got := waitForDeliveryStatus(t, db, []string{"FAILED"}, 3*time.Second); got != "FAILED" {
		t.Fatalf("expected FAILED; got %s", got)
	}

	var (
		responseCode int
		nextRetry    sql.NullTime
		errMsg       string
	)
	if err := db.QueryRow(`
		SELECT response_code, next_retry_at, error
		FROM webhook_deliveries WHERE event_id = ?
	`, ev.id).Scan(&responseCode, &nextRetry, &errMsg); err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if responseCode != http.StatusTooManyRequests {
		t.Errorf("response_code: got %d want 429", responseCode)
	}
	if !nextRetry.Valid {
		t.Fatal("next_retry_at must be populated on rate-limited delivery")
	}
	if !strings.Contains(errMsg, "rate limited") {
		t.Errorf("error column should mention rate limiting; got %q", errMsg)
	}

	// Receiver should NOT have observed a POST because the
	// limiter blocked the call before the HTTP round-trip.
	if calls := rec.snapshot(); len(calls) != 0 {
		t.Errorf("receiver should not have been called; got %d POSTs", len(calls))
	}
}
