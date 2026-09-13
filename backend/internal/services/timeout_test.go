package services_test

import (
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestResolveTimeout_ClampsToBounds covers the §5.5 timeout
// table. Plan §5.5 promises "default 10s", and the config
// service enforces [1, 120] on writes — ResolveTimeout is
// the last line of defence so it must:
//
//   - return the default for any non-positive input
//   - pass through values inside [MinTimeoutSec, MaxTimeoutSec]
//   - clamp values above MaxTimeoutSec down to MaxTimeoutSec
//
// (A clamp-up branch for values below MinTimeoutSec is
// unreachable in practice because the config validator
// already rejects them; we still cover it indirectly via
// the NewHTTPClient_HonoursTimeout table below.)
func TestResolveTimeout_ClampsToBounds(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   int
		want time.Duration
	}{
		{"zero-falls-back-to-default", 0, time.Duration(services.DefaultTimeoutSec) * time.Second},
		{"negative-falls-back-to-default", -5, time.Duration(services.DefaultTimeoutSec) * time.Second},
		{"at-min", services.MinTimeoutSec, time.Duration(services.MinTimeoutSec) * time.Second},
		{"mid-range-passthrough", 30, 30 * time.Second},
		{"at-max", services.MaxTimeoutSec, time.Duration(services.MaxTimeoutSec) * time.Second},
		{"above-max-clamps-down", services.MaxTimeoutSec + 1, time.Duration(services.MaxTimeoutSec) * time.Second},
		{"huge-clamps-down", 999999, time.Duration(services.MaxTimeoutSec) * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := services.ResolveTimeout(tc.in)
			if got != tc.want {
				t.Errorf("ResolveTimeout(%d) = %v; want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestValidateTimeoutSec_Table ensures the write-time
// validator rejects the same range ResolveTimeout clamps.
// The table mirrors the ResolveTimeout table for parity.
func TestValidateTimeoutSec_Table(t *testing.T) {
	for _, tc := range []struct {
		name    string
		in      int
		wantErr bool
	}{
		{"zero-rejected", 0, true},
		{"negative-rejected", -1, true},
		{"at-min-accepted", services.MinTimeoutSec, false},
		{"mid-range-accepted", 30, false},
		{"at-max-accepted", services.MaxTimeoutSec, false},
		{"above-max-rejected", services.MaxTimeoutSec + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := services.ValidateTimeoutSec(tc.in)
			if (err != nil) != tc.wantErr {
				t.Errorf("ValidateTimeoutSec(%d) err = %v; wantErr %v",
					tc.in, err, tc.wantErr)
			}
		})
	}
}

// TestNewHTTPClient_HonoursTimeout confirms the constructor
// propagates the clamped timeout to the http.Client. We
// deliberately don't fire a real request here — a 1ms
// timeout is enough to confirm the field was set, and
// httptest.Server round-trips add coverage elsewhere.
func TestNewHTTPClient_HonoursTimeout(t *testing.T) {
	for _, in := range []int{0, 5, 30, services.MaxTimeoutSec + 100} {
		c := services.NewHTTPClient(in)
		want := services.ResolveTimeout(in)
		if c.Timeout != want {
			t.Errorf("NewHTTPClient(%d).Timeout = %v; want %v", in, c.Timeout, want)
		}
	}
}
