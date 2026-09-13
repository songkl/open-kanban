package oauth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// ProviderSecretCipherName is the canonical cipher identifier persisted next
// to each ciphertext blob once key rotation lands. Today only AES-256-GCM is
// supported but future versions can dispatch on this prefix to transparently
// re-encrypt with a new algorithm.
const ProviderSecretCipherName = "AES-256-GCM"

// ErrProviderSecretKeyMissing is returned by EncryptProviderSecret /
// DecryptProviderSecret when no master key has been provisioned via the
// OAUTH_PROVIDER_ENCRYPTION_KEY environment variable. The server is meant
// to refuse to start in this state so plaintext secrets never reach disk
// (plan §6.2 — fail-closed).
var ErrProviderSecretKeyMissing = errors.New("oauth: OAUTH_PROVIDER_ENCRYPTION_KEY is not configured")

// ErrProviderSecretCiphertext is returned when a stored blob cannot be
// decrypted (truncation, key mismatch, tampering). The handlers map this
// to a 500 with a redacted message so the on-wire error never leaks the
// underlying AES detail.
var ErrProviderSecretCiphertext = errors.New("oauth: client_secret ciphertext is malformed or has been tampered with")

// providerSecretCipher caches the AES-GCM AEAD constructed from the
// 32-byte master key. The cipher is stateless once built, so a single
// process-wide instance is safe and avoids re-parsing the env var on
// every CRUD request.
var (
	providerSecretCipherOnce sync.Once
	providerSecretCipher     cipher.AEAD
	providerSecretCipherErr  error
)

// loadProviderSecretCipher resolves the master key from the environment and
// returns a ready-to-use cipher.AEAD. The first call after process start
// locks the result for the lifetime of the process; subsequent env var
// changes are ignored on purpose so a misconfigured reload cannot silently
// flip ciphertexts to garbage.
func loadProviderSecretCipher() (cipher.AEAD, error) {
	providerSecretCipherOnce.Do(func() {
		raw := os.Getenv("OAUTH_PROVIDER_ENCRYPTION_KEY")
		if raw == "" {
			providerSecretCipherErr = ErrProviderSecretKeyMissing
			return
		}
		key, err := hex.DecodeString(raw)
		if err != nil {
			providerSecretCipherErr = fmt.Errorf("oauth: OAUTH_PROVIDER_ENCRYPTION_KEY is not valid hex: %w", err)
			return
		}
		if len(key) != 32 {
			providerSecretCipherErr = fmt.Errorf("oauth: OAUTH_PROVIDER_ENCRYPTION_KEY must decode to 32 bytes (got %d)", len(key))
			return
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			providerSecretCipherErr = fmt.Errorf("oauth: aes.NewCipher: %w", err)
			return
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			providerSecretCipherErr = fmt.Errorf("oauth: cipher.NewGCM: %w", err)
			return
		}
		providerSecretCipher = aead
	})
	return providerSecretCipher, providerSecretCipherErr
}

// ResetProviderSecretCipherForTest clears the cached cipher so unit tests
// can swap the OAUTH_PROVIDER_ENCRYPTION_KEY environment variable between
// cases. Production code MUST NOT call this.
func ResetProviderSecretCipherForTest() {
	providerSecretCipherOnce = sync.Once{}
	providerSecretCipher = nil
	providerSecretCipherErr = nil
}

// EncryptProviderSecret seals the given plaintext with AES-256-GCM using a
// fresh 12-byte nonce. The returned blob is the wire format documented on
// oauth_providers.client_secret (plan §6.2): nonce || tag || ciphertext,
// which the database stores as BLOB so it can't be casually grep'd for
// plaintext.
//
// An empty plaintext returns (nil, nil) so the column can stay NULL for
// public-client providers (device flow, PKCE-only) — see plan §3.2.
func EncryptProviderSecret(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, nil
	}
	aead, err := loadProviderSecretCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("oauth: read nonce: %w", err)
	}
	// Seal appends tag || ciphertext to nonce, yielding the canonical
	// 12-byte-prefixed blob.
	return aead.Seal(nonce, nonce, plaintext, nil), nil
}

// DecryptProviderSecret reverses EncryptProviderSecret. The 12-byte nonce
// is read off the front of the blob; the remainder is split into tag ||
// ciphertext by the AEAD itself. An empty / nil blob returns ("", nil)
// to mirror the NULL-as-public-client convention.
func DecryptProviderSecret(blob []byte) (string, error) {
	if len(blob) == 0 {
		return "", nil
	}
	aead, err := loadProviderSecretCipher()
	if err != nil {
		return "", err
	}
	if len(blob) < aead.NonceSize() {
		return "", ErrProviderSecretCiphertext
	}
	nonce, ct := blob[:aead.NonceSize()], blob[aead.NonceSize():]
	plain, err := aead.Open(nil, nonce, ct, nil)
	if err != nil {
		// Swallow the AEAD error so callers never see "cipher: message
		// authentication failed" on the wire — that detail leaks key
		// rotation timing. The on-wire error is mapped to 500 by the
		// CRUD handlers.
		return "", ErrProviderSecretCiphertext
	}
	return string(plain), nil
}
