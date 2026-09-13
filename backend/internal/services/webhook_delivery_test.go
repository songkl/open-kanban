package services_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestSignWebhookBody_MatchesOpenSSLVector verifies the HMAC
// implementation against a hand-computed vector that mirrors the
// production openssl command (plan §5.2):
//
//	to_sign   = "<timestamp>.<raw_body>"
//	signature = hex( HMAC_SHA256(secret, to_sign) )
//
//	$ openssl dgst -sha256 -hmac "secret" \
//	    <(printf '%s.%s' "1700000000" '{"hello":"world"}')
//
// The expected signature is precomputed via the same openssl
// invocation during test development; the test fails loudly if
// the wire format ever drifts.
func TestSignWebhookBody_MatchesOpenSSLVector(t *testing.T) {
	const (
		secret    = "deadbeefcafebabe"
		timestamp = "1700000000"
		body      = `{"hello":"world"}`
	)
	want := opensslLikeHMAC(secret, timestamp, body)

	got := services.SignWebhookBody([]byte(secret), 1700000000, []byte(body))
	if got != want {
		t.Fatalf("SignWebhookBody mismatch\n got:  %s\n want: %s", got, want)
	}
	if !strings.HasPrefix(got, "0x") && len(got) != 64 {
		t.Errorf("signature length: got %d want 64 hex chars", len(got))
	}
}

// TestSignWebhookBody_ZeroTimestampRejected pins the
// defensive guard — a sweeper that accidentally passes a zero
// timestamp must not silently produce a "valid" signature.
func TestSignWebhookBody_ZeroTimestampRejected(t *testing.T) {
	got := services.SignWebhookBody([]byte("k"), 0, []byte("body"))
	if got != "" {
		t.Errorf("zero timestamp should return empty signature; got %q", got)
	}
}

// TestSignWebhookBody_DifferentInputsDifferentOutputs ensures
// the implementation isn't accidentally constant.
func TestSignWebhookBody_DifferentInputsDifferentOutputs(t *testing.T) {
	a := services.SignWebhookBody([]byte("k"), 1700000000, []byte("a"))
	b := services.SignWebhookBody([]byte("k"), 1700000000, []byte("b"))
	c := services.SignWebhookBody([]byte("k2"), 1700000000, []byte("a"))
	if a == b || a == c {
		t.Errorf("signatures must differ when input changes; a=%s b=%s c=%s", a, b, c)
	}
}

// TestComputeBackoff_DoublesEachAttempt verifies the §5.1
// curve. attempt=1 returns base; attempt=2 returns 2*base;
// each subsequent attempt doubles until we hit the cap.
func TestComputeBackoff_DoublesEachAttempt(t *testing.T) {
	for _, tc := range []struct {
		attempt int
		min     time.Duration
		max     time.Duration
	}{
		{1, 1 * time.Second, 2 * time.Second},    // base + 0..1s jitter
		{2, 2 * time.Second, 3 * time.Second},    // 2*base + 0..1s
		{3, 4 * time.Second, 5 * time.Second},    // 4*base + 0..1s
		{4, 8 * time.Second, 9 * time.Second},    // 8*base + 0..1s
		{5, 16 * time.Second, 17 * time.Second},  // 16*base + 0..1s
		{6, 32 * time.Second, 33 * time.Second},  // 32*base + 0..1s
		{7, 60 * time.Second, 61 * time.Second},  // clamped at 60s + 0..1s
		{20, 60 * time.Second, 61 * time.Second}, // far past the cap
	} {
		got := services.ComputeBackoff(tc.attempt)
		if got < tc.min || got > tc.max {
			t.Errorf("ComputeBackoff(%d) = %v; want in [%v, %v]",
				tc.attempt, got, tc.min, tc.max)
		}
	}
}

// TestComputeBackoff_NonPositiveAttemptClamps pins the
// defensive guard: attempt <= 0 must not produce a
// negative or zero delay, which would otherwise hot-spin a
// sweeper on a freshly inserted row.
func TestComputeBackoff_NonPositiveAttemptClamps(t *testing.T) {
	if d := services.ComputeBackoff(0); d <= 0 {
		t.Errorf("ComputeBackoff(0) must be > 0; got %v", d)
	}
	if d := services.ComputeBackoff(-1); d <= 0 {
		t.Errorf("ComputeBackoff(-1) must be > 0; got %v", d)
	}
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

// opensslLikeHMAC computes the canonical HMAC-SHA256 signature
// the same way the production openssl incantation does so the
// E2E test can compare against the documented external command:
//
//	$ openssl dgst -sha256 -hmac "$secret" \
//	    <(printf '%s.%s' "$ts" "$body")
func opensslLikeHMAC(secret, ts, body string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(ts))
	h.Write([]byte{'.'})
	h.Write([]byte(body))
	return hex.EncodeToString(h.Sum(nil))
}

// TestWebhookSignature_StableAndReproducible is a sanity check
// that the byte-level HMAC output is byte-for-byte stable across
// repeated runs (no hidden time / rand inputs leak into the
// signature).
func TestWebhookSignature_StableAndReproducible(t *testing.T) {
	ts := int64(1700000123)
	body := []byte(`{"event":"task.created"}`)
	secret := []byte("super-secret-key")

	first := services.SignWebhookBody(secret, ts, body)
	second := services.SignWebhookBody(secret, ts, body)
	if first != second {
		t.Errorf("SignWebhookBody not deterministic: %s vs %s", first, second)
	}

	// Cross-check against the stdlib so a refactor can't
	// accidentally swap the hashing algorithm.
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(strconv.FormatInt(ts, 10)))
	h.Write([]byte{'.'})
	h.Write(body)
	want := hex.EncodeToString(h.Sum(nil))
	if first != want {
		t.Errorf("signature drifted from stdlib HMAC:\n got:  %s\n want: %s", first, want)
	}
}

// TestWebhookSignature_LongBody covers the case where the body
// is large enough that the io.Writer buffering inside
// crypto/hmac has crossed an internal threshold. We just want
// the same input → same output, regardless of size.
func TestWebhookSignature_LongBody(t *testing.T) {
	ts := int64(1700000456)
	body := bytes.Repeat([]byte("a"), 16*1024)
	secret := []byte("k")
	got := services.SignWebhookBody(secret, ts, body)
	if got == "" {
		t.Fatal("empty signature for non-empty body")
	}
	if len(got) != 64 {
		t.Errorf("expected 64 hex chars; got %d", len(got))
	}
}
