// Package services — timeout.go centralises the per-request
// timeout configuration described in plan §5.5 of
// docs/EVENT_CENTER_PLAN_s-1138.md:
//
//	Per-request TimeoutSec (default 10 s). Connections that
//	exceed it count as a failed attempt and retry.
//
// The webhook_deliveries table stores timeout_sec on the
// parent webhooks row (migration 012). The deliverer reads
// it from the matched webhook, ResolveTimeout clamps it to
// a safe range, and the http.Client built in
// webhook_delivery.go uses the resolved value as both the
// http.Client.Timeout and the request-level context
// deadline.
//
// Defaults & bounds
//
// The plan §5.5 / schema default is 10 s. The config service
// enforces a [1, 120] range on writes (see
// webhook_config_service.go → validateWebhookConfig), so
// ResolveTimeout is the last line of defence: any value that
// slipped through (zero from a manual SQL update, negative
// from a buggy caller) gets clamped back to the default.
package services

import (
	"errors"
	"net/http"
	"time"
)

// DefaultTimeoutSec is the per-request timeout applied when
// the webhook row is missing or carries a non-positive
// timeout_sec. Plan §5.5 default.
const DefaultTimeoutSec = 10

// MinTimeoutSec / MaxTimeoutSec bound the per-request timeout
// so a hostile / buggy webhook row can't tie up a worker for
// hours or spin a context-cancellation race below the
// runtime's clock granularity.
const (
	MinTimeoutSec = 1
	MaxTimeoutSec = 120
)

// ErrTimeoutOutOfRange is returned by ValidateTimeoutSec when
// the supplied value falls outside [MinTimeoutSec,
// MaxTimeoutSec]. Config-time validation uses this so the
// HTTP handler can render a typed 400.
var ErrTimeoutOutOfRange = errors.New("services: timeoutSec out of range")

// ResolveTimeout clamps a webhook's stored timeout_sec down
// to a safe range and falls back to DefaultTimeoutSec when
// the input is non-positive. Returning a positive duration is
// guaranteed so callers can hand the result straight to
// http.Client{Timeout: ...} without a separate guard.
func ResolveTimeout(timeoutSec int) time.Duration {
	if timeoutSec <= 0 {
		return DefaultTimeoutSec * time.Second
	}
	if timeoutSec < MinTimeoutSec {
		timeoutSec = MinTimeoutSec
	}
	if timeoutSec > MaxTimeoutSec {
		timeoutSec = MaxTimeoutSec
	}
	return time.Duration(timeoutSec) * time.Second
}

// ValidateTimeoutSec is the write-time validator the config
// service invokes before persisting the row. Mirrors the
// [MinTimeoutSec, MaxTimeoutSec] range so a slow URL never
// sneaks in via a manual update.
func ValidateTimeoutSec(timeoutSec int) error {
	if timeoutSec < MinTimeoutSec || timeoutSec > MaxTimeoutSec {
		return ErrTimeoutOutOfRange
	}
	return nil
}

// NewHTTPClient builds the http.Client the deliverer uses for
// one request. Centralising the construction here keeps the
// timeout handling in one place — the deliverer no longer
// needs to know the Min/Max clamp rules.
func NewHTTPClient(timeoutSec int) *http.Client {
	return &http.Client{Timeout: ResolveTimeout(timeoutSec)}
}
