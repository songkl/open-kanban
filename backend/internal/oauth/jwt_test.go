package oauth_test

import (
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/base64"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/oauth"
)

// initSchema creates the minimal app_config table for the signing-key store.
func initSchema(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("create app_config: %v", err)
	}
	return db
}

func seedSigner(t *testing.T) (*oauth.Signer, *sql.DB) {
	t.Helper()
	db := initSchema(t)
	s := oauth.NewSigner(db)
	if err := s.LoadOrGenerate(); err != nil {
		t.Fatalf("LoadOrGenerate: %v", err)
	}
	return s, db
}

func TestSignerLoadOrGenerateCreatesKey(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	jwks, err := s.JWKS()
	if err != nil {
		t.Fatalf("JWKS: %v", err)
	}
	if len(jwks.Keys) != 1 {
		t.Fatalf("expected 1 jwk, got %d", len(jwks.Keys))
	}
	jwk := jwks.Keys[0]
	if jwk.Kty != "RSA" {
		t.Errorf("expected kty=RSA, got %s", jwk.Kty)
	}
	if jwk.Alg != "RS256" {
		t.Errorf("expected alg=RS256, got %s", jwk.Alg)
	}
	if jwk.Kid == "" {
		t.Error("expected non-empty kid")
	}
	// n and e must be valid base64url
	if _, err := base64.RawURLEncoding.DecodeString(jwk.N); err != nil {
		t.Errorf("invalid jwk.n base64: %v", err)
	}
	if _, err := base64.RawURLEncoding.DecodeString(jwk.E); err != nil {
		t.Errorf("invalid jwk.e base64: %v", err)
	}
}

func TestSignerLoadOrGenerateReusesPersistedKey(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	first, err := s.JWKS()
	if err != nil {
		t.Fatalf("JWKS: %v", err)
	}
	firstKid := first.Keys[0].Kid
	firstN := first.Keys[0].N

	// Second instance over the same DB must reuse the persisted key.
	s2 := oauth.NewSigner(db)
	if err := s2.LoadOrGenerate(); err != nil {
		t.Fatalf("LoadOrGenerate on second signer: %v", err)
	}
	second, err := s2.JWKS()
	if err != nil {
		t.Fatalf("JWKS on second signer: %v", err)
	}
	if second.Keys[0].Kid != firstKid {
		t.Errorf("expected reused kid %s, got %s", firstKid, second.Keys[0].Kid)
	}
	if second.Keys[0].N != firstN {
		t.Errorf("expected reused n, got different modulus")
	}
}

func TestSignerLoadOrGenerateDifferentDBsProduceDifferentKeys(t *testing.T) {
	s1, db1 := seedSigner(t)
	defer db1.Close()
	s2, db2 := seedSigner(t)
	defer db2.Close()

	k1, _ := s1.JWKS()
	k2, _ := s2.JWKS()
	if k1.Keys[0].Kid == k2.Keys[0].Kid {
		t.Errorf("expected distinct kids for separate DBs, both = %s", k1.Keys[0].Kid)
	}
	if k1.Keys[0].N == k2.Keys[0].N {
		t.Errorf("expected distinct moduli for separate DBs")
	}
}

func TestSignerSignAndVerify(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
			ID:        "jti-1",
		},
		ClientID:  "open-kanban-mcp",
		Scope:     "kanban:read tasks:write",
		TokenType: oauth.TokenTypeAccess,
	}

	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if !strings.Contains(tok, ".") {
		t.Fatalf("expected JWT to contain dots, got %q", tok)
	}

	verified, err := s.VerifyAccessToken(tok, "https://kanban.example", "kanban")
	if err != nil {
		t.Fatalf("VerifyAccessToken: %v", err)
	}
	if verified.Subject != "user-1" {
		t.Errorf("expected subject user-1, got %s", verified.Subject)
	}
	if verified.Scope != claims.Scope {
		t.Errorf("expected scope %s, got %s", claims.Scope, verified.Scope)
	}
	if verified.ClientID != claims.ClientID {
		t.Errorf("expected client_id %s, got %s", claims.ClientID, verified.ClientID)
	}
}

func TestSignerVerifyRejectsWrongAudience(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"wrong-aud"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeAccess,
	}
	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	_, err = s.VerifyAccessToken(tok, "https://kanban.example", "kanban")
	if !errors.Is(err, oauth.ErrInvalidAudience) {
		t.Errorf("expected ErrInvalidAudience, got %v", err)
	}
}

func TestSignerVerifyRejectsWrongIssuer(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://attacker.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeAccess,
	}
	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	_, err = s.VerifyAccessToken(tok, "https://kanban.example", "kanban")
	if !errors.Is(err, oauth.ErrInvalidIssuer) {
		t.Errorf("expected ErrInvalidIssuer, got %v", err)
	}
}

func TestSignerVerifyRejectsExpired(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now-10, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now-100, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeAccess,
	}
	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	_, err = s.VerifyAccessToken(tok, "https://kanban.example", "kanban")
	if !errors.Is(err, oauth.ErrTokenExpired) {
		t.Errorf("expected ErrTokenExpired, got %v", err)
	}
}

func TestSignerVerifyRejectsWrongTokenType(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeRefresh,
	}
	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	_, err = s.VerifyAccessToken(tok, "https://kanban.example", "kanban")
	if !errors.Is(err, oauth.ErrInvalidTokenType) {
		t.Errorf("expected ErrInvalidTokenType, got %v", err)
	}
}

func TestSignerVerifyRejectsTamperedSignature(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeAccess,
	}
	tok, err := s.Sign(claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("expected JWT with 3 parts, got %d", len(parts))
	}
	tampered := parts[0] + "." + parts[1] + "." + flipLastChar(parts[2])
	_, err = s.VerifyAccessToken(tampered, "https://kanban.example", "kanban")
	if err == nil {
		t.Fatal("expected error for tampered signature, got nil")
	}
	if !errors.Is(err, oauth.ErrTokenInvalid) {
		t.Errorf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestSignerVerifyRejectsTokenSignedWithDifferentKey(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()

	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate other key: %v", err)
	}
	now := time.Now().Unix()
	claims := &oauth.AccessTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://kanban.example",
			Subject:   "user-1",
			Audience:  jwt.ClaimStrings{"kanban"},
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+60, 0)),
			IssuedAt:  jwt.NewNumericDate(time.Unix(now, 0)),
		},
		ClientID:  "open-kanban-mcp",
		TokenType: oauth.TokenTypeAccess,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = "attacker-kid"
	signed, err := tok.SignedString(other)
	if err != nil {
		t.Fatalf("sign with other key: %v", err)
	}
	_, err = s.VerifyAccessToken(signed, "https://kanban.example", "kanban")
	if err == nil {
		t.Fatal("expected verification failure for foreign-signed token")
	}
}

func TestSignerEmptyTokenRejected(t *testing.T) {
	s, db := seedSigner(t)
	defer db.Close()
	_, err := s.VerifyAccessToken("", "https://kanban.example", "kanban")
	if !errors.Is(err, oauth.ErrTokenInvalid) {
		t.Errorf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestJWKBase64Encodings(t *testing.T) {
	// Validate that big.NewInt(int64(pub.E)).Bytes() produces a non-empty
	// value for typical RSA exponents and decodes round-trip.
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa: %v", err)
	}
	eBytes := big.NewInt(int64(priv.E)).Bytes()
	enc := base64.RawURLEncoding.EncodeToString(eBytes)
	dec, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		t.Fatalf("decode e: %v", err)
	}
	decoded := new(big.Int).SetBytes(dec)
	if decoded.Int64() != int64(priv.E) {
		t.Errorf("expected e=%d, got %d", priv.E, decoded.Int64())
	}
}

func flipLastChar(s string) string {
	if s == "" {
		return "A"
	}
	last := s[len(s)-1]
	var replacement byte = 'A'
	if last == 'A' {
		replacement = 'B'
	}
	return s[:len(s)-1] + string(replacement)
}