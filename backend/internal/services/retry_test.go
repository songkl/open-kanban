package services_test

import (
	"strconv"
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestRetry_BackoffMatchesPlanCurve pins the §5.1 backoff
// curve. The table enumerates attempt → expected (min, max)
// delay pairs so a refactor that subtly shifts the curve
// fails loudly. The +1 second on each max is the jitter
// allowance (see MaxJitterSeconds).
func TestRetry_BackoffMatchesPlanCurve(t *testing.T) {
	for _, tc := range []struct {
		attempt int
		min     time.Duration
		max     time.Duration
	}{
		{1, 1 * time.Second, 2 * time.Second},
		{2, 2 * time.Second, 3 * time.Second},
		{3, 4 * time.Second, 5 * time.Second},
		{4, 8 * time.Second, 9 * time.Second},
		{5, 16 * time.Second, 17 * time.Second},
		{6, 32 * time.Second, 33 * time.Second},
		{7, 60 * time.Second, 61 * time.Second}, // clamped at 60s + 0..1s
		{20, 60 * time.Second, 61 * time.Second},
	} {
		t.Run("attempt-"+strconv.Itoa(tc.attempt), func(t *testing.T) {
			got := services.ComputeBackoff(tc.attempt)
			if got < tc.min || got > tc.max {
				t.Errorf("ComputeBackoff(%d) = %v; want in [%v, %v]",
					tc.attempt, got, tc.min, tc.max)
			}
		})
	}
}

// TestRetry_BackoffClampNeverExceedsCap ensures no input
// attempt value can push the backoff past the §5.1 60s
// ceiling. The jitter is bounded at MaxJitterSeconds, so the
// absolute worst case is 60s + 1s = 61s.
func TestRetry_BackoffClampNeverExceedsCap(t *testing.T) {
	for attempt := 1; attempt <= 30; attempt++ {
		got := services.ComputeBackoff(attempt)
		if got > services.MaxBackoffSeconds*time.Second+time.Second {
			t.Errorf("ComputeBackoff(%d) = %v; must not exceed cap+jitter", attempt, got)
		}
	}
}

// TestRetry_BackoffNonPositiveAttemptClamps pins the
// defensive guard: attempt <= 0 must not produce a
// negative or zero delay.
func TestRetry_BackoffNonPositiveAttemptClamps(t *testing.T) {
	for _, attempt := range []int{-100, -1, 0} {
		got := services.ComputeBackoff(attempt)
		if got <= 0 {
			t.Errorf("ComputeBackoff(%d) = %v; must be > 0", attempt, got)
		}
	}
}

// TestRetry_BackoffProducesJitter covers the §5.1 jitter
// requirement: repeated calls for the same attempt must
// occasionally land on different values (probability of
// collision across N samples is < 1/MaxJitterSeconds^N).
//
// We don't pin a specific value (rand.Intn is non-
// deterministic by design) — we just confirm the function
// returns a value within the expected range across many
// samples so a regression that hard-codes the jitter to 0
// fails.
func TestRetry_BackoffProducesJitter(t *testing.T) {
	const samples = 64
	distinct := map[time.Duration]bool{}
	for i := 0; i < samples; i++ {
		d := services.ComputeBackoff(3) // 4s base + 0..1s jitter
		if d < 4*time.Second || d > 5*time.Second {
			t.Fatalf("ComputeBackoff(3) sample out of range: %v", d)
		}
		distinct[d] = true
	}
	// Two values are the only possible outputs (4s or 5s);
	// any sane rand source should land on both within 64
	// samples. If we only see one, jitter is broken.
	if len(distinct) < 2 {
		t.Errorf("expected jitter to produce at least 2 distinct values; got %d", len(distinct))
	}
}
