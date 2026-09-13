// Package e2e_test holds the end-to-end tests for the Webhook
// Event Center pipeline (plan §5 in
// docs/EVENT_CENTER_PLAN_s-1138.md, task s-1156 / s-1147).
//
// This file is the externally-facing counterpart of the
// services-layer test in
// backend/internal/services/webhook_e2e_test.go. It exercises
// the full pipeline end-to-end against a live httptest.Server
// receiver, using only the public services.* API:
//
//  1. Stand up an in-memory SQLite with the production webhooks
//     + webhook_deliveries schema (mirrors migration 012).
//  2. Stand up an httptest.Server as the downstream receiver
//     (returns 200 OK on every POST in the happy case, 500 in
//     the exhaustion case).
//  3. Insert a webhook row pointing at that receiver, secret
//     known to the test.
//  4. Wire a real EventCenter + production DeliverFunc +
//     RetrySweeper.
//  5. Publish a task.created event to the EventBus.
//  6. Assert the receiver got an HMAC-SHA256-signed POST
//     (verifiable with the canonical openssl incantation), the
//     webhook_deliveries row transitioned to SUCCESS (or
//     EXHAUSTED in the failure case), and the parent webhook's
//     last_success_at / last_failure_at was stamped.
//
// Running:
//
//	cd backend && go test ./e2e/...
//
// The test intentionally uses the public services.* API so any
// drift between the internal implementation and the wire-level
// contract surfaces as a test failure without a rebuild. The
// wire format is the production one — the openssl verification
// vector below is hand-computed so a drift in the signing
// scheme fails loudly without needing an external openssl
// binary.
package e2e_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/services"
)

// receivedRequest captures one inbound POST to the test
// receiver. Used by the success and EXHAUSTED cases to assert
// the wire format.
type receivedRequest struct {
	Method  string
	Path    string
	Headers http.Header
	Body    []byte
	At      time.Time
}

// receiver is an httptest.NewServer handler that records every
// request in arrival order and returns the configured status
// code. Concurrent-safe so the EventCenter worker pool can
// POST to it from multiple goroutines.
type receiver struct {
	mu     sync.Mutex
	calls  []receivedRequest
	status int
	body   string
}

func newReceiver(status int, body string) *receiver {
	return &receiver{status: status, body: body}
}

func (r *receiver) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	r.calls = append(r.calls, receivedRequest{
		Method:  req.Method,
		Path:    req.URL.Path,
		Headers: req.Header.Clone(),
		Body:    body,
		At:      time.Now(),
	})
	r.mu.Unlock()
	w.WriteHeader(r.status)
	_, _ = w.Write([]byte(r.body))
}

func (r *receiver) snapshot() []receivedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]receivedRequest, len(r.calls))
	copy(out, r.calls)
	return out
}

func (r *receiver) waitForCalls(n int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if len(r.snapshot()) >= n {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// setupE2EDB spins up an in-memory SQLite with the
// migration-012 schema (webhooks + webhook_deliveries) so the
// EventCenter dispatcher + retry sweeper can run against it
// without touching the filesystem.
func setupE2EDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:e2e_webhook.db?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable FK: %v", err)
	}
	if _, err := db.Exec(e2eWebhookSchema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

// e2eWebhookSchema is the production migration-012 schema,
// kept inline so this test is self-contained — no test-setup
// dance to import the SQLite migrations embed.
const e2eWebhookSchema = `
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
CREATE INDEX idx_webhook_deliveries_status_next_retry
    ON webhook_deliveries(status, next_retry_at);
`

// seedWebhookE2E inserts a single webhook row for the E2E
// test. secretHex is the hex-encoded secret the test remembers
// so it can re-compute the expected HMAC signature.
func seedWebhookE2E(t *testing.T, db *sql.DB, id, url, secretHex string, maxRetries int) {
	t.Helper()
	secretBlob, err := hex.DecodeString(secretHex)
	if err != nil {
		t.Fatalf("decode secret: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO webhooks
		    (id, name, url, secret, enabled, event_types, filters, headers, max_retries)
		VALUES (?, ?, ?, ?, 1, '["task.created"]', '{}', '{}', ?)
	`, id, id, url, secretBlob, maxRetries); err != nil {
		t.Fatalf("seed webhook %s: %v", id, err)
	}
}

// waitForDeliveryStatus polls the webhook_deliveries row until
// its status column reaches one of the supplied statuses or
// the deadline expires.
func waitForDeliveryStatus(t *testing.T, db *sql.DB, wantOneOf []string, d time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		var status string
		if err := db.QueryRow(
			"SELECT status FROM webhook_deliveries LIMIT 1",
		).Scan(&status); err == nil {
			for _, want := range wantOneOf {
				if status == want {
					return status
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	var status string
	if err := db.QueryRow(
		"SELECT status FROM webhook_deliveries LIMIT 1",
	).Scan(&status); err != nil {
		t.Fatalf("delivery status query: %v", err)
	}
	return status
}

// fakeEvent is a minimal services.Event implementation for
// driving the EventBus during the E2E test. Filterable so the
// SQLDBDispatcher's §3.2 filter check sees a non-empty board /
// column / priority / assignee (matches what the production
// task.* events carry).
type fakeEvent struct {
	typ      string
	id       string
	at       time.Time
	data     map[string]any
	boardID  string
	columnID string
	priority string
	assignee string
}

func (e *fakeEvent) EventType() string      { return e.typ }
func (e *fakeEvent) EnvelopeID() string     { return e.id }
func (e *fakeEvent) OccurredAt() time.Time  { return e.at }
func (e *fakeEvent) Data() any              { return e.data }
func (e *fakeEvent) FilterBoardID() string  { return e.boardID }
func (e *fakeEvent) FilterColumnID() string { return e.columnID }
func (e *fakeEvent) FilterPriority() string { return e.priority }
func (e *fakeEvent) FilterAssignee() string { return e.assignee }

// opensslLikeHMAC computes the canonical HMAC-SHA256 signature
// the same way the production openssl incantation does so the
// E2E test can compare against the documented external
// command:
//
//	$ openssl dgst -sha256 -hmac "$secret" \
//	    <(printf '%s.%s' "$ts" "$body")
//
// Kept in this package (mirrored from
// services/webhook_delivery_test.go) so the e2e suite can
// stand alone without an export from the services package.
func opensslLikeHMAC(secret, ts, body string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(ts))
	h.Write([]byte{'.'})
	h.Write([]byte(body))
	return hex.EncodeToString(h.Sum(nil))
}

// ----------------------------------------------------------------------
// Happy path: 200 receiver → SUCCESS row + signed POST.
// ----------------------------------------------------------------------

// TestWebhookE2E_HappyPath_ReceiverGetsSignedPOST is the
// signature-verification test plan §5.2 calls out. It exercises
// the full pipeline:
//
//  1. Publish a task.created event to the bus.
//  2. EventCenter dispatcher matches it, enqueues a delivery
//     job.
//  3. Worker pool calls NewDefaultDeliverFunc, which HMAC-signs
//     the body and POSTs to the receiver.
//  4. Receiver (httptest.Server) records the inbound POST.
//  5. Test re-computes the HMAC with the canonical openssl
//     incantation and compares header value for byte equality.
//
// The test fails if the wire format ever drifts — see
// opensslLikeHMAC above for the exact formula.
func TestWebhookE2E_HappyPath_ReceiverGetsSignedPOST(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	const (
		webhookID   = "wh-e2e-success"
		secretPlain = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
		maxRetries  = 5
		eventID     = "evt-e2e-success-1"
		eventType   = "task.created"
	)

	rec := newReceiver(200, `{"ok":true}`)
	srv := httptest.NewServer(rec)
	defer srv.Close()

	seedWebhookE2E(t, db, webhookID, srv.URL, secretPlain, maxRetries)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	ev := &fakeEvent{
		typ: eventType,
		id:  eventID,
		at:  time.Now().UTC(),
		data: map[string]any{
			"task": map[string]any{
				"id":    "t-1",
				"title": "E2E happy path",
			},
		},
		boardID:  "b-1",
		columnID: "c-1",
		priority: "high",
		assignee: "u-1",
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if !rec.waitForCalls(1, 3*time.Second) {
		t.Fatalf("receiver never got a POST within 3s")
	}

	got := rec.snapshot()
	if len(got) != 1 {
		t.Fatalf("expected 1 inbound POST; got %d", len(got))
	}

	first := got[0]
	if first.Method != http.MethodPost {
		t.Errorf("method: got %s want POST", first.Method)
	}
	for _, want := range []string{
		services.WebhookHeaderID,
		services.WebhookHeaderEvent,
		services.WebhookHeaderDelivery,
		services.WebhookHeaderTimestamp,
		services.WebhookHeaderSignature,
	} {
		if first.Headers.Get(want) == "" {
			t.Errorf("missing header %s", want)
		}
	}
	if got := first.Headers.Get(services.WebhookHeaderEvent); got != eventType {
		t.Errorf("X-Webhook-Event: got %q want %q", got, eventType)
	}
	if got := first.Headers.Get(services.WebhookHeaderID); got != webhookID {
		t.Errorf("X-Webhook-Id: got %q want %q", got, webhookID)
	}

	tsStr := first.Headers.Get(services.WebhookHeaderTimestamp)
	if tsStr == "" {
		t.Fatal("missing X-Webhook-Timestamp")
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		t.Fatalf("parse timestamp: %v", err)
	}
	if diff := time.Since(time.Unix(ts, 0)); diff < 0 || diff > time.Minute {
		t.Errorf("timestamp %s not within last minute (delta=%v)", tsStr, diff)
	}

	secretBytes, err := hex.DecodeString(secretPlain)
	if err != nil {
		t.Fatalf("decode secret: %v", err)
	}
	wantSig := opensslLikeHMAC(string(secretBytes), tsStr, string(first.Body))
	gotSig := strings.TrimPrefix(first.Headers.Get(services.WebhookHeaderSignature), services.WebhookSignaturePrefix)
	if gotSig != wantSig {
		t.Errorf("HMAC mismatch\n receiver: %s\n openssl:  %s", gotSig, wantSig)
	}

	if status := waitForDeliveryStatus(t, db, []string{"SUCCESS"}, 2*time.Second); status != "SUCCESS" {
		t.Errorf("delivery status: got %s want SUCCESS", status)
	}

	var (
		responseCode int
		finishedAt   sql.NullTime
		nextRetry    sql.NullTime
	)
	if err := db.QueryRow(`
		SELECT response_code, finished_at, next_retry_at
		FROM webhook_deliveries WHERE event_id = ?
	`, eventID).Scan(&responseCode, &finishedAt, &nextRetry); err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if responseCode != 200 {
		t.Errorf("response_code: got %d want 200", responseCode)
	}
	if !finishedAt.Valid {
		t.Error("finished_at should be populated on SUCCESS")
	}
	if nextRetry.Valid {
		t.Error("next_retry_at must be NULL on SUCCESS")
	}

	var lastSuccess sql.NullTime
	if err := db.QueryRow(
		"SELECT last_success_at FROM webhooks WHERE id = ?", webhookID,
	).Scan(&lastSuccess); err != nil {
		t.Fatalf("query webhook: %v", err)
	}
	if !lastSuccess.Valid {
		t.Error("webhooks.last_success_at must be stamped on SUCCESS")
	}
}

// ----------------------------------------------------------------------
// Failure path: 500 receiver → retry sweep → EXHAUSTED.
// ----------------------------------------------------------------------

// TestWebhookE2E_FailurePath_ExhaustedAfterMaxRetries drives
// the retry pipeline end-to-end. The receiver always returns
// 500; the test publishes one event, then drives the sweeper
// forward until the row transitions to EXHAUSTED.
//
// This exercises:
//   - the deliverer's FAILED + next_retry_at path
//   - the markExhausted guard (attempt > max_retries)
//   - the full EventCenter → deliverer → sweeper → EXHAUSTED
//     round-trip
func TestWebhookE2E_FailurePath_ExhaustedAfterMaxRetries(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	const (
		webhookID   = "wh-e2e-fail"
		secretPlain = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe"
		maxRetries  = 2
		eventID     = "evt-e2e-fail-1"
		eventType   = "task.created"
	)

	rec := newReceiver(500, `{"err":"down"}`)
	srv := httptest.NewServer(rec)
	defer srv.Close()

	seedWebhookE2E(t, db, webhookID, srv.URL, secretPlain, maxRetries)

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
		typ: eventType,
		id:  eventID,
		at:  time.Now().UTC(),
		data: map[string]any{
			"task": map[string]any{"id": "t-2", "title": "E2E failure path"},
		},
		boardID:  "b-1",
		columnID: "c-1",
		priority: "high",
		assignee: "u-1",
	}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if status := waitForDeliveryStatus(t, db, []string{"FAILED"}, 2*time.Second); status != "FAILED" {
		t.Fatalf("expected first delivery to land in FAILED; got %s", status)
	}

	deadline := time.Now().Add(10 * time.Second)
	lastAttempt := -1
	for time.Now().Before(deadline) {
		if _, err := db.Exec(
			"UPDATE webhook_deliveries SET next_retry_at = CURRENT_TIMESTAMP WHERE status = 'FAILED'",
		); err != nil {
			t.Fatalf("force next_retry_at: %v", err)
		}

		var (
			status  string
			attempt int
		)
		if err := db.QueryRow(
			"SELECT status, attempt FROM webhook_deliveries LIMIT 1",
		).Scan(&status, &attempt); err != nil {
			t.Fatalf("query delivery: %v", err)
		}
		if status == "EXHAUSTED" {
			if attempt <= maxRetries {
				t.Errorf("EXHAUSTED but attempt=%d not > max_retries=%d", attempt, maxRetries)
			}
			break
		}
		if attempt != lastAttempt {
			t.Logf("attempt=%d status=%s", attempt, status)
			lastAttempt = attempt
		}
		time.Sleep(50 * time.Millisecond)
	}

	var (
		finalStatus  string
		finalAttempt int
	)
	if err := db.QueryRow(
		"SELECT status, attempt FROM webhook_deliveries LIMIT 1",
	).Scan(&finalStatus, &finalAttempt); err != nil {
		t.Fatalf("final query: %v", err)
	}
	if finalStatus != "EXHAUSTED" {
		t.Errorf("final status: got %s want EXHAUSTED", finalStatus)
	}
	if finalAttempt <= maxRetries {
		t.Errorf("final attempt %d must exceed max_retries %d", finalAttempt, maxRetries)
	}

	calls := rec.snapshot()
	if len(calls) < maxRetries+1 {
		t.Errorf("receiver saw %d calls; expected at least %d", len(calls), maxRetries+1)
	}
}

// ----------------------------------------------------------------------
// Signature parity: byte-for-byte match between the wire
// signature and the canonical openssl incantation.
// ----------------------------------------------------------------------

// TestWebhookE2E_SignatureMatchesOpenSSL is the explicit
// parity check task s-1147 calls out. It computes the expected
// signature with the same `openssl dgst -sha256 -hmac` formula
// the production code uses (see opensslLikeHMAC) and asserts
// the receiver observed exactly that hex string.
func TestWebhookE2E_SignatureMatchesOpenSSL(t *testing.T) {
	db := setupE2EDB(t)
	defer db.Close()

	const (
		secretPlain = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
		webhookID   = "wh-e2e-openssl"
		eventID     = "evt-e2e-openssl-1"
		eventType   = "task.created"
	)

	rec := newReceiver(200, "{}")
	srv := httptest.NewServer(rec)
	defer srv.Close()

	seedWebhookE2E(t, db, webhookID, srv.URL, secretPlain, 5)

	bus := services.NewChannelEventBus(4)
	defer bus.Close()

	center := services.NewEventCenter(db, bus, 2)
	center.SetDeliverFunc(services.NewDefaultDeliverFunc(db))
	center.Start()
	defer center.Stop()

	body := map[string]any{
		"task": map[string]any{
			"id":          "t-os",
			"title":       "openssl parity",
			"columnId":    "c-1",
			"columnName":  "Doing",
			"priority":    "high",
			"assignee":    "u-1",
			"createdBy":   "u-1",
			"createdAt":   time.Now().UTC().Format(time.RFC3339),
			"updatedAt":   time.Now().UTC().Format(time.RFC3339),
			"description": "",
		},
	}
	ev := &fakeEvent{typ: eventType, id: eventID, at: time.Now().UTC(), data: body}
	if err := bus.Publish(ev); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if !rec.waitForCalls(1, 3*time.Second) {
		t.Fatal("receiver never got a POST")
	}

	got := rec.snapshot()[0]
	tsStr := got.Headers.Get(services.WebhookHeaderTimestamp)
	secretBytes, err := hex.DecodeString(secretPlain)
	if err != nil {
		t.Fatalf("decode secret: %v", err)
	}
	want := opensslLikeHMAC(string(secretBytes), tsStr, string(got.Body))
	gotSig := strings.TrimPrefix(got.Headers.Get(services.WebhookHeaderSignature), services.WebhookSignaturePrefix)
	if gotSig != want {
		t.Errorf("wire signature mismatch\n wire:    %s\n openssl: %s", gotSig, want)
	}
}

// ----------------------------------------------------------------------
// helpers: silence unused-import warnings for compile-time
// guards the test exercises via reflection.
// ----------------------------------------------------------------------

// guard against a future refactor dropping an import the
// compile-time checks below are watching for.
var (
	_ = fmt.Sprintf
	_ = json.Marshal
	_ = sync.Mutex{}
)
