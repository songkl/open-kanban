package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupSignatureTestRouter(enabled bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()

	if enabled {
		os.Setenv("SIGNATURE_ENABLED", "1")
		os.Setenv("SIGNATURE_SECRETS", "test-key:my-secret-key")
		loadSignatureSecrets()
		SetSignatureEnabled(true)
	} else {
		os.Setenv("SIGNATURE_ENABLED", "0")
		os.Unsetenv("SIGNATURE_SECRETS")
		loadSignatureSecrets()
		SetSignatureEnabled(false)
	}

	r.POST("/test", RequireSignatureVerification(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	return r
}

func TestComputeHMAC(t *testing.T) {
	data := "1234567890GET/test123"
	secret := "my-secret-key"

	sig1 := ComputeHMAC(data, secret)
	sig2 := ComputeHMAC(data, secret)

	assert.Equal(t, sig1, sig2, "Same input should produce same HMAC")
	assert.NotEmpty(t, sig1)

	differentSig := ComputeHMAC("different-data", secret)
	assert.NotEqual(t, sig1, differentSig, "Different input should produce different HMAC")
}

func TestVerifyHMAC(t *testing.T) {
	data := "1234567890GET/test123"
	secret := "my-secret-key"

	sig := ComputeHMAC(data, secret)

	assert.True(t, VerifyHMAC(sig, sig), "Same signature should verify")
	assert.False(t, VerifyHMAC(sig, "different-signature"), "Different signature should not verify")
}

func TestHashBody(t *testing.T) {
	emptyHash := HashBody([]byte{})
	assert.Equal(t, sha256EmptyString, emptyHash)

	body := []byte(`{"test":"data"}`)
	hash := HashBody(body)
	assert.NotEmpty(t, hash)
	assert.Len(t, hash, 64)

	hash2 := HashBody(body)
	assert.Equal(t, hash, hash2, "Same body should produce same hash")
}

func TestGenerateSignature(t *testing.T) {
	data := SignatureData{
		Timestamp: 1234567890,
		Method:    "GET",
		Path:      "/api/v1/test",
		BodyHash:  sha256EmptyString,
	}
	secret := "my-secret-key"

	sig := GenerateSignature(data, secret)
	assert.NotEmpty(t, sig)

	sig2 := GenerateSignature(data, secret)
	assert.Equal(t, sig, sig2, "Same data should produce same signature")
}

func TestVerifySignature(t *testing.T) {
	data := SignatureData{
		Timestamp: 1234567890,
		Method:    "GET",
		Path:      "/api/v1/test",
		BodyHash:  sha256EmptyString,
	}
	secret := "my-secret-key"

	sig := GenerateSignature(data, secret)
	assert.True(t, VerifySignature(data, sig, secret))

	wrongData := SignatureData{
		Timestamp: 1234567891,
		Method:    "GET",
		Path:      "/api/v1/test",
		BodyHash:  sha256EmptyString,
	}
	assert.False(t, VerifySignature(wrongData, sig, secret))
}

func TestValidateTimestamp(t *testing.T) {
	now := time.Now().Unix()

	assert.True(t, ValidateTimestamp(now), "Current timestamp should be valid")

	validPast := now - int64(SignatureValidity.Seconds())/2
	assert.True(t, ValidateTimestamp(validPast), "Timestamp within validity window should be valid")

	expired := now - int64(SignatureValidity.Seconds())*2
	assert.False(t, ValidateTimestamp(expired), "Timestamp beyond validity window should be invalid")

	future := now + 60
	assert.False(t, ValidateTimestamp(future), "Future timestamp should be invalid")
}

func TestRequireSignatureVerification_Enabled_NoHeaders(t *testing.T) {
	r := setupSignatureTestRouter(true)

	req, _ := http.NewRequest("POST", "/test", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "Missing signature headers")
}

func TestRequireSignatureVerification_Enabled_ValidSignature(t *testing.T) {
	r := setupSignatureTestRouter(true)

	body := []byte(`{"test":"data"}`)
	timestamp := time.Now().Unix()

	data := SignatureData{
		Timestamp: timestamp,
		Method:    "POST",
		Path:      "/test",
		BodyHash:  HashBody(body),
	}
	signature := GenerateSignature(data, "my-secret-key")

	req, _ := http.NewRequest("POST", "/test", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, signature)
	req.Header.Set(TimestampHeader, strconv.FormatInt(timestamp, 10))
	req.Header.Set(AccessKeyHeader, "test-key")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestRequireSignatureVerification_Enabled_InvalidSignature(t *testing.T) {
	r := setupSignatureTestRouter(true)

	body := []byte(`{"test":"data"}`)
	timestamp := time.Now().Unix()

	req, _ := http.NewRequest("POST", "/test", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, "invalid-signature")
	req.Header.Set(TimestampHeader, strconv.FormatInt(timestamp, 10))
	req.Header.Set(AccessKeyHeader, "test-key")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "Invalid signature")
}

func TestRequireSignatureVerification_Enabled_ExpiredTimestamp(t *testing.T) {
	r := setupSignatureTestRouter(true)

	body := []byte(`{"test":"data"}`)
	expiredTimestamp := time.Now().Add(-10 * time.Minute).Unix()

	data := SignatureData{
		Timestamp: expiredTimestamp,
		Method:    "POST",
		Path:      "/test",
		BodyHash:  HashBody(body),
	}
	signature := GenerateSignature(data, "my-secret-key")

	req, _ := http.NewRequest("POST", "/test", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, signature)
	req.Header.Set(TimestampHeader, strconv.FormatInt(expiredTimestamp, 10))
	req.Header.Set(AccessKeyHeader, "test-key")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "expired")
}

func TestRequireSignatureVerification_Enabled_InvalidAccessKey(t *testing.T) {
	r := setupSignatureTestRouter(true)

	body := []byte(`{"test":"data"}`)
	timestamp := time.Now().Unix()

	data := SignatureData{
		Timestamp: timestamp,
		Method:    "POST",
		Path:      "/test",
		BodyHash:  HashBody(body),
	}
	signature := GenerateSignature(data, "my-secret-key")

	req, _ := http.NewRequest("POST", "/test", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, signature)
	req.Header.Set(TimestampHeader, strconv.FormatInt(timestamp, 10))
	req.Header.Set(AccessKeyHeader, "wrong-key")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "Invalid access key")
}

func TestRequireSignatureVerification_Disabled(t *testing.T) {
	r := setupSignatureTestRouter(false)

	body := []byte(`{"test":"data"}`)
	req, _ := http.NewRequest("POST", "/test", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestRequireSignatureVerification_OptionsRequest(t *testing.T) {
	r := setupSignatureTestRouter(true)

	req, _ := http.NewRequest("OPTIONS", "/test", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSetSignatureSecrets(t *testing.T) {
	secrets := map[string]string{
		"key1": "secret1",
		"key2": "secret2",
	}
	SetSignatureSecrets(secrets)

	retrieved := GetSignatureSecrets()
	require.Equal(t, 2, len(retrieved))
	assert.Equal(t, "secret1", retrieved["key1"])
	assert.Equal(t, "secret2", retrieved["key2"])

	SetSignatureSecrets(make(map[string]string))
}

func TestSignatureIntegration(t *testing.T) {
	accessKey := "integration-test-key"
	secret := "integration-secret"
	SetSignatureSecrets(map[string]string{accessKey: secret})
	SetSignatureEnabled(true)

	timestamp := time.Now().Unix()
	method := "POST"
	path := "/api/v1/tasks"
	body := []byte(`{"title":"Test Task","columnId":"col-123"}`)

	data := SignatureData{
		Timestamp: timestamp,
		Method:    method,
		Path:      path,
		BodyHash:  HashBody(body),
	}

	signature := GenerateSignature(data, secret)
	assert.True(t, VerifySignature(data, signature, secret))

	data.BodyHash = HashBody([]byte(`{"title":"Modified"}`))
	assert.False(t, VerifySignature(data, signature, secret))
}
