// Package services — webhook_delivery.go implements the production
// DeliverFunc that signs a delivery job's body with HMAC-SHA256
// and POSTs it to the webhook URL.
//
// The signing surface lives in signer.go (plan §5.2), the
// backoff curve in retry.go (plan §5.1), the per-webhook
// outbound throttle in rate_limiter.go (plan §5.3), and the
// per-request timeout in timeout.go (plan §5.5). This file is
// just the glue that orchestrates them per attempt.
//
// Signing surface (plan §5.2):
//
//	X-Webhook-Id:        <webhook.id>
//	X-Webhook-Event:     <event.type>
//	X-Webhook-Delivery:  <delivery.id>
//	X-Webhook-Timestamp: <unix seconds>
//	X-Webhook-Signature: sha256=<hex hmac>
//
// Custom headers configured via the webhooks.headers JSON column
// are merged in (operator-supplied values may override our
// defaults — useful when an operator wants to add `X-Tenant-Id`
// or similar to every call).
//
// The status update on each attempt follows migration-012's
// state machine:
//
//	2xx response  → status = 'SUCCESS', response_code = <code>,
//	                 last_success_at = now, finished_at = now,
//	                 next_retry_at = NULL
//	non-2xx       → status = 'FAILED',  response_code = <code>,
//	                 last_failure_at = now, finished_at = now,
//	                 next_retry_at = backoff(attempt) + jitter
//	network error → status = 'FAILED',  response_code = 0,
//	                 last_failure_at = now, finished_at = now,
//	                 next_retry_at = backoff(attempt) + jitter
//	rate limited  → status = 'FAILED',  response_code = 429,
//	                 next_retry_at = rateLimiter.RescheduleAt()
//	                 (plan §5.3: NextRetryAt += 1 s)
//
// The retry sweeper (retry_sweeper.go) is responsible for
// re-enqueueing FAILED rows whose next_retry_at has elapsed and
// transitioning FAILED → EXHAUSTED once the attempt counter
// exceeds webhooks.max_retries.
package services

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// Webhook signature header names — exported so receivers and
// tests can read them without string-typing the constants.
const (
	WebhookHeaderID        = "X-Webhook-Id"
	WebhookHeaderEvent     = "X-Webhook-Event"
	WebhookHeaderDelivery  = "X-Webhook-Delivery"
	WebhookHeaderTimestamp = "X-Webhook-Timestamp"
	WebhookHeaderSignature = "X-Webhook-Signature"
	WebhookSignaturePrefix = "sha256="
	WebhookSignatureVersion = "sha256"
)

// DefaultDeliverDeps bundles the optional dependencies the
// production DeliverFunc accepts. A zero value is valid — the
// limiter-less / sweeper-less / telemetry-less code paths stay
// in place so unit tests can construct a DeliverFunc without
// wiring every subsystem.
type DefaultDeliverDeps struct {
	DB          *sql.DB
	RateLimiter *RateLimiter
}

// NewDefaultDeliverFunc returns the production DeliverFunc that
// signs each job's body and POSTs it to job.URL with a
// per-request timeout derived from the job's TimeoutSec field
// (via timeout.go → ResolveTimeout).
//
// The returned function performs these side-effects per call:
//
//  1. Consult the per-webhook rate limiter (rate_limiter.go).
//     When the cap is exhausted, stamp the row FAILED with a
//     429 response_code and reschedule per §5.3 without
//     burning an HTTP round-trip.
//  2. Otherwise POST the signed body, capturing the response
//     code, body (first 4 KiB), and any network error.
//  3. UPDATE the matching webhook_deliveries row with the
//     attempt outcome (status, response_code, response_body,
//     error, finished_at, next_retry_at).
//  4. Stamp last_success_at / last_failure_at on the parent
//     webhooks row.
//
// The function never panics; a malformed DeliveryJob is logged
// and returns nil so the worker pool can keep moving.
func NewDefaultDeliverFunc(db *sql.DB) DeliverFunc {
	return NewDefaultDeliverFuncWithDeps(DefaultDeliverDeps{DB: db})
}

// NewDefaultDeliverFuncWithDeps is the constructor used when
// the deliverer needs more than just the DB handle. The
// production wiring (cmd/server) injects the RateLimiter here
// so a hot-reload can swap the cap without restarting workers.
func NewDefaultDeliverFuncWithDeps(deps DefaultDeliverDeps) DeliverFunc {
	return func(ctx context.Context, job *DeliveryJob) error {
		if job == nil {
			return nil
		}
		if job.URL == "" {
			slog.Error("webhook_delivery: empty URL",
				"delivery_id", job.DeliveryID,
				"webhook_id", job.WebhookID)
			return nil
		}

		// Rate-limit gate (plan §5.3). When the limiter
		// rejects the call we stamp FAILED with a 429
		// response_code and reschedule via
		// RescheduleAt so the retry sweeper picks the row
		// back up. The attempt counter is preserved so the
		// next try uses the correct backoff bucket.
		if deps.RateLimiter != nil && !deps.RateLimiter.Allow(job.WebhookID) {
			next := deps.RateLimiter.RescheduleAt(job.WebhookID, job.Attempt)
			updateDeliveryRateLimited(deps.DB, job, next)
			return nil
		}

		timestamp := time.Now().Unix()
		signature := SignWebhookBody(job.Secret, timestamp, job.Body)

		client := NewHTTPClient(job.TimeoutSec)
		timeout := ResolveTimeout(job.TimeoutSec)

		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, job.URL, bytes.NewReader(job.Body))
		if err != nil {
			updateDeliveryFailure(deps.DB, job, 0, "", fmt.Sprintf("build request: %v", err))
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Open-Kanban-Webhook/1.0")
		req.Header.Set(WebhookHeaderID, job.WebhookID)
		req.Header.Set(WebhookHeaderEvent, job.EventType)
		req.Header.Set(WebhookHeaderDelivery, job.DeliveryID)
		req.Header.Set(WebhookHeaderTimestamp, strconv.FormatInt(timestamp, 10))
		req.Header.Set(WebhookHeaderSignature, WebhookSignaturePrefix+signature)

		// Merge operator-supplied headers (auth tokens, custom
		// X-Tenant-Id, etc.) on top of our defaults. Operator
		// values win so an operator can override the User-Agent
		// or pin their own X-Webhook-Signature version if they
		// need to.
		if job.Headers != "" {
			extra := map[string]string{}
			if err := json.Unmarshal([]byte(job.Headers), &extra); err == nil {
				for k, v := range extra {
					req.Header.Set(k, v)
				}
			} else {
				slog.Warn("webhook_delivery: malformed headers JSON",
					"delivery_id", job.DeliveryID,
					"webhook_id", job.WebhookID,
					"error", err)
			}
		}

		resp, err := client.Do(req)
		if err != nil {
			// Distinguish timeouts from generic network
			// errors in the response_code column so the
			// deliveries page (plan §7.3) can surface
			// "timed out" vs "connection refused" without
			// parsing the error string.
			code := 0
			if isTimeoutError(err) {
				code = http.StatusRequestTimeout
			}
			updateDeliveryFailure(deps.DB, job, code, "", fmt.Sprintf("http error: %v", err))
			return nil
		}
		defer func() { _ = resp.Body.Close() }()

		// Capture first 4 KiB of body per plan §4 — a chatty
		// receiver can't fill the database.
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			updateDeliverySuccess(deps.DB, job, resp.StatusCode, string(bodyBytes))
			return nil
		}

		updateDeliveryFailure(deps.DB, job, resp.StatusCode, string(bodyBytes),
			fmt.Sprintf("non-2xx response: %d", resp.StatusCode))
		return nil
	}
}

// isTimeoutError reports whether err originated from the
// per-request context deadline (plan §5.5). We deliberately
// don't reach into net.Error / url.Error to keep the check
// conservative — only true context.DeadlineExceeded and the
// http.Client's wrapped timeout count.
func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if err == context.DeadlineExceeded {
		return true
	}
	// http.Client wraps the context error in a
	// *url.Error; the unwrap chain lands on
	// context.DeadlineExceeded for both Go 1.13 and
	// older toolchains. The string check is a belt-and-
	// braces fallback so a future Go release that drops
	// the unwrap chain still surfaces timeouts correctly.
	return errStringContainsTimeout(err.Error())
}

func errStringContainsTimeout(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, needle := range []string{"context deadline exceeded", "Client.Timeout exceeded"} {
		if indexOf(s, needle) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(haystack, needle string) int {
	if len(needle) == 0 {
		return 0
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

// updateDeliverySuccess marks the delivery row as SUCCESS and
// stamps last_success_at on the parent webhook. The
// webhook_deliveries row keeps the row around after success so
// the deliveries page (§7.3) can show the historical log.
func updateDeliverySuccess(db *sql.DB, job *DeliveryJob, code int, body string) {
	if db == nil {
		return
	}
	now := time.Now().UTC()
	_, err := db.Exec(`
		UPDATE webhook_deliveries
		SET status = 'SUCCESS',
		    response_code = ?,
		    response_body = ?,
		    error = '',
		    attempt = ?,
		    finished_at = ?,
		    next_retry_at = NULL
		WHERE id = ?
	`, code, body, job.Attempt, now, job.DeliveryID)
	if err != nil {
		slog.Error("webhook_delivery: success update failed",
			"delivery_id", job.DeliveryID, "error", err)
		return
	}
	if _, err := db.Exec(
		"UPDATE webhooks SET last_success_at = ? WHERE id = ?",
		now, job.WebhookID,
	); err != nil {
		slog.Warn("webhook_delivery: last_success_at stamp failed",
			"webhook_id", job.WebhookID, "error", err)
	}
}

// updateDeliveryFailure marks the delivery row as FAILED and
// schedules next_retry_at via the §5.1 backoff curve. The
// transition to EXHAUSTED is owned by the retry sweeper (see
// retry_sweeper.go) which knows the per-webhook max_retries.
func updateDeliveryFailure(db *sql.DB, job *DeliveryJob, code int, body, errMsg string) {
	if db == nil {
		return
	}
	now := time.Now().UTC()
	nextRetry := now.Add(ComputeBackoff(job.Attempt))
	_, err := db.Exec(`
		UPDATE webhook_deliveries
		SET status = 'FAILED',
		    response_code = ?,
		    response_body = ?,
		    error = ?,
		    attempt = ?,
		    finished_at = ?,
		    next_retry_at = ?
		WHERE id = ?
	`, code, body, errMsg, job.Attempt, now, nextRetry, job.DeliveryID)
	if err != nil {
		slog.Error("webhook_delivery: failure update failed",
			"delivery_id", job.DeliveryID, "error", err)
		return
	}
	if _, err := db.Exec(
		"UPDATE webhooks SET last_failure_at = ? WHERE id = ?",
		now, job.WebhookID,
	); err != nil {
		slog.Warn("webhook_delivery: last_failure_at stamp failed",
			"webhook_id", job.WebhookID, "error", err)
	}
}

// updateDeliveryRateLimited is the §5.3 path: the limiter
// rejected the call before we burned an HTTP round-trip. We
// still want the row visible in the deliveries feed so we
// stamp FAILED with response_code=429 (the canonical
// "too many requests" code receivers expect) and pin
// next_retry_at to the limiter's reschedule suggestion.
//
// attempt is preserved (not bumped) so the eventual delivery
// uses the same backoff bucket — rate limiting is a transient
// condition, not a failure mode.
func updateDeliveryRateLimited(db *sql.DB, job *DeliveryJob, next time.Time) {
	if db == nil {
		return
	}
	if next.IsZero() {
		// Limiter told us not to bother; fall back to the
		// regular backoff curve so the row doesn't sit in
		// FAILED with next_retry_at=NULL.
		next = time.Now().UTC().Add(ComputeBackoff(job.Attempt))
	}
	now := time.Now().UTC()
	_, err := db.Exec(`
		UPDATE webhook_deliveries
		SET status = 'FAILED',
		    response_code = 429,
		    response_body = '',
		    error = 'rate limited',
		    attempt = ?,
		    finished_at = ?,
		    next_retry_at = ?
		WHERE id = ?
	`, job.Attempt, now, next, job.DeliveryID)
	if err != nil {
		slog.Error("webhook_delivery: rate-limit update failed",
			"delivery_id", job.DeliveryID, "error", err)
		return
	}
	if _, err := db.Exec(
		"UPDATE webhooks SET last_failure_at = ? WHERE id = ?",
		now, job.WebhookID,
	); err != nil {
		slog.Warn("webhook_delivery: last_failure_at stamp failed",
			"webhook_id", job.WebhookID, "error", err)
	}
}
