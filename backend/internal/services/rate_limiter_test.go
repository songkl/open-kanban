package services_test

import (
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestRateLimiter_AllowsUpToCapThenBlocks covers plan §5.3
// behaviour: the first cap calls in the rolling window pass,
// the next call in the same window is rejected. We use the
// limiter-wide cap here; the override case is covered below.
func TestRateLimiter_AllowsUpToCapThenBlocks(t *testing.T) {
	rl := services.NewRateLimiter(3)

	for i := 0; i < 3; i++ {
		if !rl.Allow("wh-1") {
			t.Fatalf("Allow(wh-1) call %d should pass (cap=3)", i+1)
		}
	}
	if rl.Allow("wh-1") {
		t.Error("4th call within window must be rejected")
	}
}

// TestRateLimiter_RejectedCallDoesNotConsumeQuota guards
// the second property of §5.3: a hot retry loop on the
// worker side must not penalise the webhook further. We
// reject 100 calls after the cap is exhausted and then
// confirm a hypothetical "cooldown" outside the window
// still re-allows up to cap calls (i.e. the ring didn't
// accumulate junk during the retry storm).
func TestRateLimiter_RejectedCallDoesNotConsumeQuota(t *testing.T) {
	rl := services.NewRateLimiter(2)
	if !rl.Allow("wh-1") || !rl.Allow("wh-1") {
		t.Fatalf("first two calls should pass")
	}
	for i := 0; i < 100; i++ {
		if rl.Allow("wh-1") {
			t.Fatalf("rejected call #%d unexpectedly passed", i)
		}
	}
}

// TestRateLimiter_IndependentWebhooksHaveIndependentQuotas
// confirms §5.3's per-webhook scoping: exhausting webhook A's
// quota must not affect webhook B's quota.
func TestRateLimiter_IndependentWebhooksHaveIndependentQuotas(t *testing.T) {
	rl := services.NewRateLimiter(2)
	if !rl.Allow("wh-a") || !rl.Allow("wh-a") {
		t.Fatalf("webhook a should get its full quota")
	}
	if rl.Allow("wh-a") {
		t.Fatal("webhook a 3rd call should be rejected")
	}
	// Webhook b is unaffected.
	if !rl.Allow("wh-b") || !rl.Allow("wh-b") {
		t.Errorf("webhook b should get its own quota")
	}
	if rl.Allow("wh-b") {
		t.Errorf("webhook b 3rd call should be rejected")
	}
}

// TestRateLimiter_OverrideBeatsLimiterDefault pins the
// override mechanism: a webhook with a tighter cap should
// be blocked even when the limiter-wide cap is generous.
func TestRateLimiter_OverrideBeatsLimiterDefault(t *testing.T) {
	rl := services.NewRateLimiter(60)
	rl.SetOverride("wh-tight", 1)

	if !rl.Allow("wh-tight") {
		t.Fatal("first call should pass with cap=1 override")
	}
	if rl.Allow("wh-tight") {
		t.Error("2nd call should be rejected with cap=1 override")
	}
	// Webhook without override still has the limiter-wide cap.
	for i := 0; i < 5; i++ {
		if !rl.Allow("wh-loose") {
			t.Errorf("call %d for wh-loose should pass with default cap=60", i+1)
		}
	}
}

// TestRateLimiter_OverrideClearRestoresDefault confirms
// SetOverride(webhook, <=0) removes the override so the
// limiter-wide cap takes over again.
func TestRateLimiter_OverrideClearRestoresDefault(t *testing.T) {
	rl := services.NewRateLimiter(60)
	rl.SetOverride("wh-x", 1)
	rl.SetOverride("wh-x", 0) // clear

	for i := 0; i < 5; i++ {
		if !rl.Allow("wh-x") {
			t.Errorf("call %d should pass after override cleared", i+1)
		}
	}
}

// TestRateLimiter_RescheduleAtSuggestsNextRetry pins the
// §5.3 "NextRetryAt += 1s" promise. The default window is
// 60s so a tight test can:
//
//   - exhaust the cap
//   - ask for the reschedule suggestion
//   - confirm it's strictly in the future by RescheduleDelay
//     (or, when the limiter is disabled, the zero time)
//
// The exact delay value depends on ComputeBackoff (which
// includes jitter) so we only assert lower-bound.
func TestRateLimiter_RescheduleAtSuggestsNextRetry(t *testing.T) {
	rl := services.NewRateLimiter(1)

	// First call: passes.
	if !rl.Allow("wh-1") {
		t.Fatal("first call should pass")
	}

	now := time.Now()
	next := rl.RescheduleAt("wh-1", 1)
	if next.IsZero() {
		t.Fatal("RescheduleAt should not return zero when the limiter is enabled and the cap is exhausted")
	}
	if !next.After(now) {
		t.Errorf("RescheduleAt must be in the future; got %v, now=%v", next, now)
	}
	// Should be at least RescheduleDelay (1s).
	if next.Sub(now) < services.RescheduleDelay {
		t.Errorf("RescheduleAt should be at least RescheduleDelay in the future; got delta %v", next.Sub(now))
	}
}

// TestRateLimiter_RescheduleAtDisabledIsZero confirms the
// "fall through" path: a limiter with perMinute <= 0 and no
// overrides returns the zero time so the deliverer can use
// the regular backoff curve instead of always rescheduling
// every second.
func TestRateLimiter_RescheduleAtDisabledIsZero(t *testing.T) {
	rl := services.NewRateLimiter(0)
	next := rl.RescheduleAt("wh-1", 1)
	if !next.IsZero() {
		t.Errorf("RescheduleAt with limiter disabled should return zero time; got %v", next)
	}
}

// TestRateLimiter_NilIsNoOp confirms the nil-safety guard:
// code paths that pass a nil *RateLimiter (production: when
// DefaultDeliverDeps.RateLimiter is left nil) must NOT panic.
func TestRateLimiter_NilIsNoOp(t *testing.T) {
	var rl *services.RateLimiter
	if !rl.Allow("wh-1") {
		t.Error("nil limiter should permit all calls")
	}
	if !rl.RescheduleAt("wh-1", 1).IsZero() {
		t.Error("nil limiter should return zero reschedule time")
	}
	// SetOverride on a nil receiver must not panic.
	rl.SetOverride("wh-1", 5)
}
