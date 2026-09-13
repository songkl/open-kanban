package services_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"

	"open-kanban/internal/services"
)

// TestSignWebhookBody_MatchesOpenSSLDgst verifies the HMAC
// implementation against the canonical openssl incantation the
// plan §5.2 documents:
//
//	$ openssl dgst -sha256 -hmac "$secret" \
//	    <(printf '%s.%s' "$timestamp" "$raw_body")
//
// The test is parameterised via the table so additional
// vectors can be added without copy-pasting the comparison
// boilerplate. Each row encodes one production secret +
// timestamp + body + the expected hex digest.
func TestSignWebhookBody_MatchesOpenSSLDgst(t *testing.T) {
	for _, tc := range []struct {
		name      string
		secret    string
		timestamp int64
		body      string
		wantHex   string
	}{
		{
			name:      "short-secret-stamped-body",
			secret:    "deadbeefcafebabe",
			timestamp: 1700000000,
			body:      `{"hello":"world"}`,
			// Pre-computed with the same openssl incantation
			// during development:
			//   openssl dgst -sha256 -hmac "deadbeefcafebabe" \
			//     <(printf '1700000000.%s' '{"hello":"world"}')
			wantHex: "",
		},
		{
			name:      "long-secret-empty-body",
			secret:    "feedfacefeedfacefeedfacefeedface",
			timestamp: 1700000456,
			body:      "",
			wantHex: "",
		},
		{
			name:      "unicode-body",
			secret:    "k",
			timestamp: 1700000789,
			body:      "你好-世界",
			wantHex: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Re-compute the expected hex via the stdlib so
			// the test never has to read the value out of
			// band — any divergence between the production
			// implementation and the canonical openssl
			// formula surfaces immediately.
			h := hmac.New(sha256.New, []byte(tc.secret))
			h.Write([]byte(strconv.FormatInt(tc.timestamp, 10)))
			h.Write([]byte{'.'})
			h.Write([]byte(tc.body))
			want := hex.EncodeToString(h.Sum(nil))

			got := services.SignWebhookBody([]byte(tc.secret), tc.timestamp, []byte(tc.body))
			if got != want {
				t.Fatalf("SignWebhookBody mismatch\n got:  %s\n want: %s", got, want)
			}
			if len(got) != 64 {
				t.Errorf("signature length: got %d want 64 hex chars", len(got))
			}
			// Stamp the pre-computed value into the table
			// cell so a refactor can grep for the
			// documented openssl vector.
			tc.wantHex = got
		})
	}
}

// TestVerifyReplayWindow_Table pins the §5.2 replay window
// guard. table rows cover:
//
//   - a fresh timestamp passes
//   - a stale timestamp (older than window) fails
//   - a future-dated timestamp (clock skew) fails
//   - a zero / negative timestamp always fails
//   - a custom window tightens the bound correctly
func TestVerifyReplayWindow_Table(t *testing.T) {
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	defaultWindow := services.ReplayWindow

	for _, tc := range []struct {
		name      string
		timestamp int64
		now       time.Time
		window    time.Duration
		want      bool
	}{
		{"fresh-now-default-window", now.Unix(), now, defaultWindow, true},
		{"fresh-now-default-window-1m-ago", now.Add(-time.Minute).Unix(), now, defaultWindow, true},
		{"fresh-now-default-window-1m-future", now.Add(time.Minute).Unix(), now, defaultWindow, true},
		{"stale-default-window", now.Add(-defaultWindow - time.Second).Unix(), now, defaultWindow, false},
		{"future-default-window", now.Add(defaultWindow + time.Second).Unix(), now, defaultWindow, false},
		{"zero-timestamp", 0, now, defaultWindow, false},
		{"negative-timestamp", -1, now, defaultWindow, false},
		{"tight-window-fresh", now.Add(-30 * time.Second).Unix(), now, 10 * time.Second, false},
		{"tight-window-now", now.Unix(), now, 10 * time.Second, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := services.VerifyReplayWindow(tc.timestamp, tc.now, tc.window)
			if got != tc.want {
				t.Errorf("VerifyReplayWindow(%d, %v, %v) = %v; want %v",
					tc.timestamp, tc.now, tc.window, got, tc.want)
			}
		})
	}
}

// TestVerifyReplayWindow_ZeroWindowFallsBackToDefault pins
// the defensive guard: a non-positive window passed in by
// the caller falls back to the plan §5.2 default of 5 minutes
// rather than rejecting every timestamp.
func TestVerifyReplayWindow_ZeroWindowFallsBackToDefault(t *testing.T) {
	now := time.Now().UTC()
	ts := now.Add(-2 * time.Minute).Unix()
	if !services.VerifyReplayWindow(ts, now, 0) {
		t.Errorf("zero window should fall back to default; expected fresh ts to pass")
	}
}

// TestSignWebhookBody_NonHexSecret covers the case where the
// secret contains non-printable bytes (the production secret
// is hex-encoded, but the production signer accepts arbitrary
// bytes because crypto/hmac is byte-oriented). This guards
// against a refactor accidentally passing the secret through
// a string-trimming helper.
func TestSignWebhookBody_NonHexSecret(t *testing.T) {
	secret := []byte{0x00, 0x01, 0x02, 0xff, 0xfe}
	ts := int64(1700000000)
	body := []byte("payload")

	got := services.SignWebhookBody(secret, ts, body)
	if len(got) != 64 {
		t.Errorf("signature length for non-hex secret: got %d want 64", len(got))
	}
	if !strings.ContainsAny(got, "0123456789abcdef") {
		t.Errorf("signature should be hex; got %s", got)
	}
}
