// Package oauth implements OAuth 2.1 / RFC 7591 / RFC 8628 primitives for the
// kanban authorization server. This file handles signing keys, JWT issuance,
// JWT verification, and the JWKS document.
package oauth

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"

	"github.com/golang-jwt/jwt/v5"
)

// Standard JWT claim names and grant identifiers used across the package.
const (
	ClaimIssuer        = "iss"
	ClaimSubject       = "sub"
	ClaimAudience      = "aud"
	ClaimExpiry        = "exp"
	ClaimIssuedAt      = "iat"
	ClaimJWTID         = "jti"
	ClaimClientID      = "client_id"
	ClaimScope         = "scope"
	ClaimTokenType     = "token_type"
	ClaimAuthTime      = "auth_time"
	ClaimClientName    = "client_name"
	TokenTypeAccess    = "access"
	TokenTypeRefresh   = "refresh"
	GrantTypeDeviceCode = "urn:ietf:params:oauth:grant-type:device_code"
	GrantTypeRefresh   = "refresh_token"
	GrantTypeClientCreds = "client_credentials"
	GrantTypeAuthCode  = "authorization_code"
)

// Errors returned by the JWT utilities.
var (
	ErrKeyNotFound      = errors.New("oauth: signing key not configured")
	ErrTokenInvalid     = errors.New("oauth: token invalid")
	ErrTokenExpired     = errors.New("oauth: token expired")
	ErrInvalidAudience  = errors.New("oauth: invalid audience")
	ErrInvalidIssuer    = errors.New("oauth: invalid issuer")
	ErrInvalidTokenType = errors.New("oauth: invalid token_type claim")
)

// AccessTokenClaims is the standard OAuth access-token JWT body. It embeds
// jwt.RegisteredClaims so that the jwt/v5 library's claim validators work
// (Expiration, Issuer, Subject, Audience, IssuedAt, NotBefore, ID).
type AccessTokenClaims struct {
	jwt.RegisteredClaims
	ClientID  string `json:"client_id,omitempty"`
	Scope     string `json:"scope,omitempty"`
	TokenType string `json:"token_type"`
	AuthTime  int64  `json:"auth_time,omitempty"`
}

// SigningKey is the JSON-serialisable RSA key material stored in app_config.
type SigningKey struct {
	KID         string `json:"kid"`
	Algorithm   string `json:"alg"`
	PrivateKey  string `json:"private_key_pem"`
	PublicKey   string `json:"public_key_pem"`
	CreatedAt   int64  `json:"created_at"`
}

// JWK is the RFC 7517 representation of a public key.
type JWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS is the JSON Web Key Set document.
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// Signer loads and persists the RSA signing key for the OAuth server.
type Signer struct {
	mu          sync.RWMutex
	key         *rsa.PrivateKey
	kid         string
	algorithm   string
	db          *sql.DB
	configKeyID string // app_config key for kid
	configKeyJWK string // app_config key for serialized SigningKey
}

// NewSigner constructs a Signer. Call LoadOrGenerate on startup.
func NewSigner(db *sql.DB) *Signer {
	return &Signer{
		db:           db,
		algorithm:    "RS256",
		configKeyID:  "jwt_signing_kid",
		configKeyJWK: "jwt_signing_key",
	}
}

// LoadOrGenerate loads the persisted signing key from app_config, generating
// and persisting a new one if none exists.
func (s *Signer) LoadOrGenerate() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	stored, err := s.readStoredKey()
	if err != nil {
		return err
	}
	if stored != nil {
		if err := s.applyKey(stored); err != nil {
			return err
		}
		return nil
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("oauth: failed to generate RSA key: %w", err)
	}
	kid, err := randomKid()
	if err != nil {
		return err
	}
	marshalled, err := encodeSigningKey(priv, kid, s.algorithm)
	if err != nil {
		return err
	}
	if err := s.persistKey(marshalled); err != nil {
		return err
	}
	s.key = priv
	s.kid = kid
	return nil
}

// PublicJWK returns the JWK representation of the current public key.
func (s *Signer) PublicJWK() (JWK, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.key == nil {
		return JWK{}, ErrKeyNotFound
	}
	return jwkFromRSAPublicKey(&s.key.PublicKey, s.kid, s.algorithm)
}

// JWKS returns the full JWKS document.
func (s *Signer) JWKS() (JWKS, error) {
	jwk, err := s.PublicJWK()
	if err != nil {
		return JWKS{}, err
	}
	return JWKS{Keys: []JWK{jwk}}, nil
}

// Sign issues a JWT with the given claims using the configured signing key.
func (s *Signer) Sign(claims jwt.Claims) (string, error) {
	s.mu.RLock()
	key := s.key
	kid := s.kid
	s.mu.RUnlock()
	if key == nil {
		return "", ErrKeyNotFound
	}
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	t.Header["kid"] = kid
	return t.SignedString(key)
}

// VerifyAccessToken parses and validates an access token, returning the claims
// when they pass signature/exp/aud/iss checks.
func (s *Signer) VerifyAccessToken(raw string, expectedIssuer, expectedAudience string) (*AccessTokenClaims, error) {
	if raw == "" {
		return nil, ErrTokenInvalid
	}
	s.mu.RLock()
	key := s.key
	s.mu.RUnlock()
	if key == nil {
		return nil, ErrKeyNotFound
	}

	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(expectedIssuer),
		jwt.WithAudience(expectedAudience),
		jwt.WithExpirationRequired(),
	)
	parsed, err := parser.ParseWithClaims(raw, &AccessTokenClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return &key.PublicKey, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		if errors.Is(err, jwt.ErrTokenInvalidAudience) {
			return nil, ErrInvalidAudience
		}
		if errors.Is(err, jwt.ErrTokenInvalidIssuer) {
			return nil, ErrInvalidIssuer
		}
		return nil, fmt.Errorf("%w: %v", ErrTokenInvalid, err)
	}

	claims, ok := parsed.Claims.(*AccessTokenClaims)
	if !ok || !parsed.Valid {
		return nil, ErrTokenInvalid
	}
	if claims.TokenType != TokenTypeAccess {
		return nil, ErrInvalidTokenType
	}
	return claims, nil
}

// applyKey parses a stored SigningKey and applies it to the Signer.
func (s *Signer) applyKey(stored *SigningKey) error {
	if stored.KID == "" || stored.PrivateKey == "" {
		return fmt.Errorf("oauth: stored signing key is incomplete")
	}
	priv, err := decodePrivateKey(stored.PrivateKey)
	if err != nil {
		return err
	}
	s.key = priv
	s.kid = stored.KID
	if stored.Algorithm != "" {
		s.algorithm = stored.Algorithm
	}
	return nil
}

func (s *Signer) readStoredKey() (*SigningKey, error) {
	row := s.db.QueryRow("SELECT value FROM app_config WHERE `key` = ?", s.configKeyJWK)
	var raw string
	if err := row.Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("oauth: read signing key: %w", err)
	}
	var stored SigningKey
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return nil, fmt.Errorf("oauth: parse signing key: %w", err)
	}
	return &stored, nil
}

func (s *Signer) persistKey(stored SigningKey) error {
	data, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(
		"REPLACE INTO app_config (`key`, value) VALUES (?, ?), (?, ?)",
		s.configKeyJWK, string(data),
		s.configKeyID, stored.KID,
	); err != nil {
		return fmt.Errorf("oauth: persist signing key: %w", err)
	}
	return nil
}

// audienceMatches returns true if the audience claim contains the expected value.
func audienceMatches(claim, expected string) bool {
	if claim == expected {
		return true
	}
	return false
}

func randomKid() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	sum := sha256.Sum256(buf)
	return base64.RawURLEncoding.EncodeToString(sum[:8]), nil
}

// jwkFromRSAPublicKey converts an RSA public key to JWK form per RFC 7518 §6.3.1.
func jwkFromRSAPublicKey(pub *rsa.PublicKey, kid, alg string) (JWK, error) {
	if pub == nil {
		return JWK{}, fmt.Errorf("oauth: nil public key")
	}
	return JWK{
		Kty: "RSA",
		Use: "sig",
		Alg: alg,
		Kid: kid,
		N:   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}, nil
}