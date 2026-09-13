// Package services — retry.go implements the exponential
// backoff curve plan §5.1 of docs/EVENT_CENTER_PLAN_s-1138.md
// promises:
//
//	delay = min(60s, 2^attempt) + rand(0..1s)
//
// The curve is 1-based: attempt=1 is the initial POST and
// therefore picks the base (1s) delay on failure; attempt=N
// doubles the previous attempt until the 60s cap kicks in at
// attempt=7 (2^6 = 64, clamped to 60).
//
// Jitter is bounded at MaxJitterSeconds so the retry sweeper's
// 5s poll loop never misses an enqueue by more than a single
// cycle. Without the jitter, every failed delivery with the
// same attempt counter would land on the same
// next_retry_at second and the sweeper would re-enqueue them
// in lock-step.
//
// The retry sweeper (retry_sweeper.go) is the only consumer
// of ComputeBackoff at runtime; the deliverer writes
// next_retry_at = now + ComputeBackoff(attempt) when it
// stamps a FAILED row.
package services

import (
	"math"
	"math/rand"
	"time"
)

// DefaultBackoffBase is the seed for the exponential backoff
// curve. The plan §5.1 promise is `min(60s, 2^attempt)`
// seconds, so the curve doubles each attempt and clamps at
// 60 s. The unit is seconds because that matches the column
// semantics.
const DefaultBackoffBase = 1

// MaxBackoffSeconds clamps the backoff curve to 60 s so a
// flaky receiver can't push a delivery's next_retry_at weeks
// into the future. Plan §5.1.
const MaxBackoffSeconds = 60

// MaxJitterSeconds bounds the random jitter so the sweeper's
// poll loop (5 s) never accidentally misses an enqueue by
// more than one cycle.
const MaxJitterSeconds = 1

// ComputeBackoff returns the per-attempt backoff per plan
// §5.1:
//
//	delay = min(MaxBackoffSeconds, base * 2^attempt) + rand(0..MaxJitterSeconds)
//
// attempt is 1-based (1 == initial POST). The +1 in
// `attempt - 1` keeps the initial POST's backoff at `base`
// seconds rather than `base*2`. Passing attempt <= 0 is
// treated as attempt=1 so the curve never returns a negative
// or zero delay.
//
// The jitter is drawn from the package-level rand source so
// a fast-followup retry from the same delivery doesn't land
// on the same instant — without it the sweeper's WHERE
// next_retry_at <= now clause would re-enqueue the same row
// in lock-step.
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
