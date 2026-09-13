package oauth_test

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"

	"open-kanban/internal/oauth"
)

// validTestKey is a deterministic 32-byte key reused across subtests
// so failures are reproducible. It's not the production key; tests
// reset the cached cipher via ResetProviderSecretCipherForTest so
// the env-var value can be swapped mid-suite without leaking into
// other packages.
func validTestKey() string {
	return hex.EncodeToString(bytes.Repeat([]byte{0xAB}, 32))
}

// withProviderSecretKey sets OAUTH_PROVIDER_ENCRYPTION_KEY for the
// duration of a test and clears the cached cipher so the next call
// reads the new value. Restores the original env on cleanup.
func withProviderSecretKey(t *testing.T, key string) {
	t.Helper()
	prev, had := os.LookupEnv("OAUTH_PROVIDER_ENCRYPTION_KEY")
	if err := os.Setenv("OAUTH_PROVIDER_ENCRYPTION_KEY", key); err != nil {
		t.Fatalf("set env: %v", err)
	}
	oauth.ResetProviderSecretCipherForTest()
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("OAUTH_PROVIDER_ENCRYPTION_KEY", prev)
		} else {
			_ = os.Unsetenv("OAUTH_PROVIDER_ENCRYPTION_KEY")
		}
		oauth.ResetProviderSecretCipherForTest()
	})
}

// 1. Happy-path round-trip: encrypt then decrypt returns the
// original plaintext. Pins plan §6.2 (AES-256-GCM, 12-byte nonce
// prefix).
func TestProviderSecret_RoundTrip(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	plain := []byte("super-secret-client-secret-value")
	blob, err := oauth.EncryptProviderSecret(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if len(blob) <= 12 {
		t.Fatalf("expected nonce-prefixed ciphertext, got %d bytes", len(blob))
	}
	got, err := oauth.DecryptProviderSecret(blob)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != string(plain) {
		t.Errorf("round-trip mismatch: want %q, got %q", plain, got)
	}
}

// 2. Two encryptions of the same plaintext produce different
// ciphertexts — the per-row 12-byte nonce must be random so the
// DB never reveals duplicate secrets at a glance.
func TestProviderSecret_NonceIsRandom(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	plain := []byte("identical-input")
	a, err := oauth.EncryptProviderSecret(plain)
	if err != nil {
		t.Fatalf("encrypt a: %v", err)
	}
	b, err := oauth.EncryptProviderSecret(plain)
	if err != nil {
		t.Fatalf("encrypt b: %v", err)
	}
	if bytes.Equal(a, b) {
		t.Fatalf("expected distinct nonces, got identical ciphertext")
	}
	// Nonce is the first 12 bytes; even a 1-bit coincidence would
	// already be astronomical, but assert explicitly so a future
	// refactor that accidentally derives the nonce from the key
	// fails fast.
	if bytes.Equal(a[:12], b[:12]) {
		t.Fatalf("nonce prefix collided between two encryptions")
	}
}

// 3. Empty plaintext short-circuits to (nil, nil) so public-client
// providers (device flow, PKCE-only) can keep client_secret NULL
// in the DB rather than storing an empty ciphertext blob.
func TestProviderSecret_EmptyPlaintextReturnsNil(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	blob, err := oauth.EncryptProviderSecret(nil)
	if err != nil {
		t.Fatalf("encrypt nil: %v", err)
	}
	if blob != nil {
		t.Errorf("expected nil blob for empty plaintext, got %d bytes", len(blob))
	}
	got, err := oauth.DecryptProviderSecret(nil)
	if err != nil {
		t.Fatalf("decrypt nil: %v", err)
	}
	if got != "" {
		t.Errorf("expected empty plaintext round-trip, got %q", got)
	}
}

// 4. Missing env var surfaces as ErrProviderSecretKeyMissing so the
// CRUD handlers can map it to a 503 (fail-closed per plan §6.2).
func TestProviderSecret_MissingKey(t *testing.T) {
	withProviderSecretKey(t, "")
	if _, err := oauth.EncryptProviderSecret([]byte("x")); !errors.Is(err, oauth.ErrProviderSecretKeyMissing) {
		t.Fatalf("expected ErrProviderSecretKeyMissing, got %v", err)
	}
}

// 5. A key of the wrong length is rejected up-front so an operator
// who fat-fingers OAUTH_PROVIDER_ENCRYPTION_KEY sees a clear error
// instead of an opaque AES failure later.
func TestProviderSecret_RejectsShortKey(t *testing.T) {
	withProviderSecretKey(t, hex.EncodeToString(bytes.Repeat([]byte{0x01}, 16)))
	_, err := oauth.EncryptProviderSecret([]byte("x"))
	if err == nil {
		t.Fatal("expected error for 16-byte key")
	}
	if errors.Is(err, oauth.ErrProviderSecretKeyMissing) {
		t.Fatalf("expected length-related error, got key-missing: %v", err)
	}
}

// 6. Non-hex key is rejected with a clear error.
func TestProviderSecret_RejectsNonHexKey(t *testing.T) {
	withProviderSecretKey(t, "not-hex-data")
	_, err := oauth.EncryptProviderSecret([]byte("x"))
	if err == nil {
		t.Fatal("expected error for non-hex key")
	}
}

// 7. Tampered ciphertext fails authentication — flipping a byte in
// the tag/ciphertext region must NOT silently return a wrong
// plaintext.
func TestProviderSecret_TamperedCiphertextRejected(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	blob, err := oauth.EncryptProviderSecret([]byte("payload"))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	blob[len(blob)-1] ^= 0xFF
	_, err = oauth.DecryptProviderSecret(blob)
	if !errors.Is(err, oauth.ErrProviderSecretCiphertext) {
		t.Fatalf("expected ErrProviderSecretCiphertext, got %v", err)
	}
}

// 8. Truncated ciphertext (shorter than the nonce) returns the
// generic ciphertext error rather than panicking.
func TestProviderSecret_TruncatedCiphertextRejected(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	_, err := oauth.DecryptProviderSecret([]byte{0x01, 0x02, 0x03})
	if !errors.Is(err, oauth.ErrProviderSecretCiphertext) {
		t.Fatalf("expected ErrProviderSecretCiphertext, got %v", err)
	}
}

// 9. Nonce uniqueness across many calls — a flaky RNG that draws
// from a small pool would silently weaken AES-GCM. Generate a
// few hundred encryptions and assert no duplicate 12-byte prefix.
func TestProviderSecret_NonceUniquenessOverManyCalls(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	const n = 256
	seen := make(map[[12]byte]struct{}, n)
	for i := 0; i < n; i++ {
		blob, err := oauth.EncryptProviderSecret([]byte("same"))
		if err != nil {
			t.Fatalf("encrypt %d: %v", i, err)
		}
		var nonce [12]byte
		copy(nonce[:], blob[:12])
		if _, dup := seen[nonce]; dup {
			t.Fatalf("nonce collision at iteration %d", i)
		}
		seen[nonce] = struct{}{}
	}
	if len(seen) != n {
		t.Fatalf("expected %d distinct nonces, got %d", n, len(seen))
	}
	_ = rand.Reader // keep the crypto/rand import alive for future tests
}
