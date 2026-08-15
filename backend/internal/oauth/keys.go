package oauth

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
)

// encodeSigningKey serialises an RSA private key to PEM and returns a stored
// SigningKey record. The PEM is encrypted at rest when the database is
// encrypted; this function only handles the textual format.
func encodeSigningKey(priv *rsa.PrivateKey, kid, alg string) (SigningKey, error) {
	if priv == nil {
		return SigningKey{}, errors.New("oauth: nil private key")
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return SigningKey{}, fmt.Errorf("marshal private key: %w", err)
	}
	block := &pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	}
	return SigningKey{
		KID:        kid,
		Algorithm:  alg,
		PrivateKey: string(pem.EncodeToMemory(block)),
		PublicKey:  string(pem.EncodeToMemory(&pem.Block{
			Type:  "PUBLIC KEY",
			Bytes: mustMarshalPublicKey(&priv.PublicKey),
		})),
		CreatedAt: nowUnix(),
	}, nil
}

// decodePrivateKey parses a PEM-encoded private key (PKCS8 or PKCS1).
func decodePrivateKey(pemEncoded string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemEncoded))
	if block == nil {
		return nil, errors.New("oauth: no PEM block found")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, errors.New("oauth: private key is not RSA")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("oauth: failed to parse private key (PKCS1 or PKCS8)")
}

func mustMarshalPublicKey(pub *rsa.PublicKey) []byte {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		panic(fmt.Sprintf("oauth: marshal public key: %v", err))
	}
	return der
}

// nowUnix is a package-private indirection so tests can stub the clock later.
var nowUnix = func() int64 {
	return timeNow().Unix()
}