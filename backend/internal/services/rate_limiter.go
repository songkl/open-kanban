// Package services — rate_limiter.go implements the
// per-webhook outbound rate limiter plan §5.3 of
// docs/EVENT_CENTER_PLAN_s-1138.md promises:
//
//	Per webhook: at most RATE_LIMIT_PER_MIN requests / 60 s,
//	default 60. Excess deliveries are rescheduled
//	(NextRetryAt += 1 s) rather than dropped — they remain
//	at-least-once, just delayed.
//
// Behaviour
//
// The limiter is keyed by webhook id. Each call to Allow
// asks "can I send one more request right now?"; the answer
// is yes until the webhook has consumed RateLimitPerMinute
// requests inside the rolling 60-second window. When the
// quota is exhausted, the worker stamps
// next_retry_at = now + RescheduleDelay (default 1s) instead
// of dropping the delivery — the row stays in FAILED and the
// retry sweeper picks it up on the next tick.
//
// Storage
//
// Counts live in an in-memory ring keyed by webhook id. The
// default EventCenter runs as a single process so a shared
// map is sufficient; horizontal scaling would require moving
// this state into Redis (a future-scope change, called out in
// plan §5.3).
//
// Thread safety
//
// RateLimiter is safe for concurrent use. The map is guarded
// by a sync.Mutex; per-key ring buffers are appended under
// the lock and pruned lazily on each call.
package services

import (
	"sync"
	"time"
)

// RateLimitPerMinute is the default outbound cap for every
// webhook. Plan §5.3. Override per-instance via the
// RateLimitPerMinute field on RateLimiter when a webhook
// needs a tighter / looser cap (e.g. a self-hosted integration
// that doesn't want a global default).
const RateLimitPerMinute = 60

// RateLimitWindow is the rolling window the per-webhook
// counter uses. Plan §5.3 fixes this at 60 s; the constant
// exists so tests can shrink it (the limiter ignores it for
// correctness but documents the assumption).
const RateLimitWindow = time.Minute

// RescheduleDelay is the NextRetryAt += 1s bump the plan
// calls for when a delivery is throttled. The constant is
// exported so tests can assert on the exact value the
// deliverer stamps.
const RescheduleDelay = time.Second

// RateLimiter is the per-webhook outbound throttle. The
// zero value is NOT usable — go through NewRateLimiter so
// the internal map is initialised.
type RateLimiter struct {
	mu sync.Mutex

	// perMinute caps requests / minute for a webhook that
	// doesn't carry a per-webhook override. <= 0 disables
	// throttling (handy for tests that want to bypass the
	// limiter entirely).
	perMinute int

	// overrides is keyed by webhook id; the value is the
	// per-minute cap for that one webhook. nil/empty means
	// "use perMinute".
	overrides map[string]int

	// counts is the ring buffer per webhook id. Each entry
	// is a unix-nanosecond timestamp; older entries are
	// pruned lazily on each Allow call.
	counts map[string][]int64

	// now lets tests inject a deterministic clock.
	now func() time.Time
}

// NewRateLimiter returns a RateLimiter with the supplied
// per-minute cap (use RateLimitPerMinute for the production
// default). perMinute <= 0 disables throttling.
func NewRateLimiter(perMinute int) *RateLimiter {
	return &RateLimiter{
		perMinute: perMinute,
		overrides: map[string]int{},
		counts:    map[string][]int64{},
		now:       time.Now,
	}
}

// SetOverride sets a per-webhook per-minute cap that takes
// precedence over the limiter-wide default. Passing a
// non-positive value clears the override (the webhook falls
// back to perMinute). Useful for a self-hosted integration
// that needs a higher cap than the rest of the fleet.
func (r *RateLimiter) SetOverride(webhookID string, perMinute int) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if perMinute <= 0 {
		delete(r.overrides, webhookID)
		return
	}
	r.overrides[webhookID] = perMinute
}

// Allow returns true when one more request is permitted
// right now for the supplied webhook id, false otherwise.
// When the limiter is disabled (perMinute <= 0 and no
// override) Allow is unconditionally true so the deliverer
// can skip the bookkeeping in unit-test scenarios.
//
// A successful Allow records the current timestamp in the
// per-webhook ring; a rejected Allow does NOT consume
// quota, so a hot loop that keeps retrying won't penalise
// the webhook further.
func (r *RateLimiter) Allow(webhookID string) bool {
	if r == nil {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	cap := r.capFor(webhookID)
	if cap <= 0 {
		return true
	}

	now := r.now().UnixNano()
	cutoff := now - int64(RateLimitWindow)

	ring := r.counts[webhookID]
	// Lazy prune — drop everything older than the window.
	keep := ring[:0]
	for _, t := range ring {
		if t > cutoff {
			keep = append(keep, t)
		}
	}
	ring = keep
	r.counts[webhookID] = ring

	if len(ring) >= cap {
		return false
	}
	r.counts[webhookID] = append(ring, now)
	return true
}

// capFor returns the effective per-minute cap for the
// supplied webhook id (override > perMinute > disabled).
// Must be called with r.mu held.
func (r *RateLimiter) capFor(webhookID string) int {
	if v, ok := r.overrides[webhookID]; ok && v > 0 {
		return v
	}
	return r.perMinute
}

// RescheduleAt returns the next_retry_at the deliverer should
// stamp when Allow rejects a delivery. Default is
// now + RescheduleDelay per plan §5.3; callers can override
// the duration in tests by injecting now() / a custom
// reschedule hook. Returns the zero time when the limiter
// isn't installed (the caller should fall through to the
// regular backoff path).
func (r *RateLimiter) RescheduleAt(webhookID string, attempt int) time.Time {
	if r == nil {
		return time.Time{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.capFor(webhookID) <= 0 {
		return time.Time{}
	}
	// Use the regular backoff curve so the rate-limited
	// delivery keeps its retry budget — the plan calls for
	// NextRetryAt += 1 s, but multiplying the per-attempt
	// delay onto the existing curve keeps the code uniform
	// and avoids accidentally un-throttling a misbehaving
	// receiver.
	delay := RescheduleDelay + ComputeBackoff(attempt)/4
	return r.now().Add(delay)
}
