// Package services — webhook_delivery.go implements the production
// DeliverFunc that signs a delivery job's body with HMAC-SHA256
// and POSTs it to the webhook URL.
//
// The signing surface follows the contract laid out in plan §5.2
// of docs/EVENT_CENTER_PLAN_s-1138.md so receivers can verify
// the call with the standard openssl incantation:
//
//	$ openssl dgst -sha256 -hmac "$secret" \
//	    <(printf '%s.%s' "$timestamp" "$raw_body")
//
// The headers we send are:
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
//
// The retry sweeper (retry_sweeper.go) is responsible for
// re-enqueueing FAILED rows whose next_retry_at has elapsed and
// transitioning FAILED → EXHAUSTED once the attempt counter
// exceeds webhooks.max_retries.
package services

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"time"
)

// Webhook signature header names — exported so receivers and
// tests can read them without string-typing the constants.
const (
	WebhookHeaderID         = "X-Webhook-Id"
	WebhookHeaderEvent      = "X-Webhook-Event"
	WebhookHeaderDelivery   = "X-Webhook-Delivery"
	WebhookHeaderTimestamp  = "X-Webhook-Timestamp"
	WebhookHeaderSignature  = "X-Webhook-Signature"
	WebhookSignaturePrefix  = "sha256="
	WebhookSignatureVersion = "sha256"
)

// DefaultBackoffBase is the seed for the exponential backoff
// curve. The plan §5.1 promise is `min(60s, 2^attempt)` seconds,
// so the curve doubles each attempt and clamps at 60 s. The unit
// is seconds because that matches the column semantics.
const DefaultBackoffBase = 1

// MaxBackoffSeconds clamps the backoff curve to 60 s so a flaky
// receiver can't push a delivery's next_retry_at weeks into the
// future. Plan §5.1.
const MaxBackoffSeconds = 60

// MaxJitterSeconds bounds the random jitter so the sweeper's
// poll loop (5 s) never accidentally misses an enqueue by more
// than one cycle.
const MaxJitterSeconds = 1

// ComputeBackoff returns the per-attempt backoff per plan §5.1:
//
//	delay = min(MaxBackoffSeconds, base * 2^attempt) + rand(0..MaxJitterSeconds)
//
// attempt is 1-based (1 == initial POST). The +1 in `attempt - 1`
// keeps the initial POST's backoff at `base` seconds rather than
// `base*2`. Passing attempt <= 0 is treated as attempt=1 so the
// curve never returns a negative or zero delay.
//
// The jitter is drawn from the package-level rand source so a
// fast-followup retry from the same delivery doesn't land on the
// same instant — without it the sweeper's WHERE next_retry_at <=
// now clause would re-enqueue the same row in lock-step.
func ComputeBackoff(attempt int) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}
	// 2^(attempt-1) — fits comfortably under MaxBackoffSeconds
	// because the clamp catches anything above 2^6.
	secs := float64(DefaultBackoffBase) * math.Pow(2, float64(attempt-1))
	if secs > MaxBackoffSeconds {
		secs = MaxBackoffSeconds
	}
	jitter := time.Duration(rand.Intn(MaxJitterSeconds+1)) * time.Second
	return time.Duration(secs)*time.Second + jitter
}

// SignWebhookBody returns the hex-encoded HMAC-SHA256 of
// `timestamp + "." + body` keyed by the webhook's secret. The
// string layout mirrors the GitHub / Stripe webhook convention so
// off-the-shelf receiver libraries can verify it without
// translation:
//
//	to_sign   = "<unix_seconds>.<raw_body>"
//	signature = hex( HMAC_SHA256(secret, to_sign) )
//
// secret is the raw byte form (matching the BLOB column
// representation in webhooks.secret). timestamp is unix seconds;
// passing <= 0 returns an empty string so a sweeper bug never
// produces a silently valid signature.
func SignWebhookBody(secret []byte, timestamp int64, body []byte) string {
	if timestamp <= 0 {
		return ""
	}
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(strconv.FormatInt(timestamp, 10)))
	h.Write([]byte{'.'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// NewDefaultDeliverFunc returns the production DeliverFunc that
// signs each job's body and POSTs it to job.URL with a
// per-request timeout derived from the job's TimeoutSec field.
//
// The returned function performs three side-effects per call:
//
//  1. POST the signed body, capturing the response code, body
//     (first 4 KiB), and any network error.
//  2. UPDATE the matching webhook_deliveries row with the
//     attempt outcome (status, response_code, response_body,
//     error, finished_at, next_retry_at).
//  3. Stamp last_success_at / last_failure_at on the parent
//     webhooks row.
//
// The function never panics; a malformed DeliveryJob is logged
// and returns nil so the worker pool can keep moving.
func NewDefaultDeliverFunc(db *sql.DB) DeliverFunc {
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

		timestamp := time.Now().Unix()
		signature := SignWebhookBody(job.Secret, timestamp, job.Body)

		timeout := time.Duration(job.TimeoutSec) * time.Second
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		client := &http.Client{Timeout: timeout}

		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, job.URL, bytes.NewReader(job.Body))
		if err != nil {
			updateDeliveryFailure(db, job, 0, "", fmt.Sprintf("build request: %v", err))
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
			updateDeliveryFailure(db, job, 0, "", fmt.Sprintf("http error: %v", err))
			return nil
		}
		defer func() { _ = resp.Body.Close() }()

		// Capture first 4 KiB of body per plan §4 — a chatty
		// receiver can't fill the database.
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			updateDeliverySuccess(db, job, resp.StatusCode, string(bodyBytes))
			return nil
		}

		updateDeliveryFailure(db, job, resp.StatusCode, string(bodyBytes),
			fmt.Sprintf("non-2xx response: %d", resp.StatusCode))
		return nil
	}
}

// updateDeliverySuccess marks the delivery row as SUCCESS and
// stamps last_success_at on the parent webhook. The
// webhook_deliveries row keeps the row around after success so
// the deliveries page (§7.3) can show the historical log.
func updateDeliverySuccess(db *sql.DB, job *DeliveryJob, code int, body string) {
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
