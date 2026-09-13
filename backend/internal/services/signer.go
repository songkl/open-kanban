// Package services — signer.go implements the HMAC-SHA256
// webhook signing scheme described in plan §5.2 of
// docs/EVENT_CENTER_PLAN_s-1138.md.
//
// Wire format
//
// Every webhook POST carries these headers (see also the
// constants exposed as WebhookHeader* below):
//
//	X-Webhook-Id:        <webhook.id>
//	X-Webhook-Event:     <event.type>
//	X-Webhook-Delivery:  <delivery.id>
//	X-Webhook-Timestamp: <unix seconds>
//	X-Webhook-Signature: sha256=<hex hmac>
//
// The signature itself is the hex-encoded HMAC-SHA256 of
// `timestamp + "." + raw_body` keyed by the webhook's secret:
//
//	to_sign   = "<unix_seconds>.<raw_body>"
//	signature = hex( HMAC_SHA256(secret, to_sign) )
//
// Receivers verify the call with the canonical openssl
// incantation:
//
//	$ openssl dgst -sha256 -hmac "$secret" \
//	    <(printf '%s.%s' "$timestamp" "$raw_body")
//
// Replay-window validation
//
// Plan §5.2 promises receivers reject events whose timestamp
// is more than 5 minutes off. That guard is enforced on the
// receiver side; the sender side's responsibility is to
// publish the timestamp and signature such that the
// receiver-side check is unambiguous. VerifyReplayWindow
// below is the helper receivers (and our own integration
// tests) use to enforce the same window against the canonical
// unix-second timestamp:
//
//	|now - timestamp| <= ReplayWindow (default 5 minutes)
//
// Signing-time responsibilities
//
//   - Secret is the raw byte form (matching the BLOB column
//     representation in webhooks.secret) — callers pass the
//     []byte straight from the matched webhook row.
//   - Timestamp is unix seconds; a zero or negative value is
//     treated as "no signature" so a sweeper bug never produces
//     a silently valid signature.
//   - Empty body is supported so a webhook that emits a 0-byte
//     payload still signs deterministically.
package services

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// ReplayWindow is the maximum clock drift (sender vs receiver)
// that plan §5.2 tolerates. The plan calls for 5 minutes;
// keeping the value as a constant lets tests tighten it down
// to a few milliseconds without re-deriving it from a config
// flag every time.
const ReplayWindow = 5 * time.Minute

// SignWebhookBody returns the hex-encoded HMAC-SHA256 of
// `timestamp + "." + body` keyed by the webhook's secret. The
// string layout mirrors the GitHub / Stripe webhook convention
// so off-the-shelf receiver libraries can verify it without
// translation:
//
//	to_sign   = "<unix_seconds>.<raw_body>"
//	signature = hex( HMAC_SHA256(secret, to_sign) )
//
// secret is the raw byte form (matching the BLOB column
// representation in webhooks.secret). timestamp is unix
// seconds; passing <= 0 returns an empty string so a sweeper
// bug never produces a silently valid signature.
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

// VerifyReplayWindow is the receiver-side helper that
// enforces the §5.2 replay window. It returns true when the
// absolute difference between now and timestamp is <= the
// supplied window; the plan default is 5 minutes but tests
// pass a tighter value to keep the suite fast.
//
// A zero or negative timestamp always returns false — a
// missing / spoofed header must never pass validation.
func VerifyReplayWindow(timestamp int64, now time.Time, window time.Duration) bool {
	if timestamp <= 0 {
		return false
	}
	if window <= 0 {
		window = ReplayWindow
	}
	ts := time.Unix(timestamp, 0)
	delta := now.Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	return delta <= window
}
