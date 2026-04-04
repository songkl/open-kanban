package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	SignatureHeader   = "X-Signature"
	TimestampHeader   = "X-Timestamp"
	AccessKeyHeader   = "X-Access-Key"
	SignatureValidity = 5 * time.Minute
)

var (
	signatureEnabled = os.Getenv("SIGNATURE_ENABLED") == "1"
	signatureSecrets = make(map[string]string)
)

func init() {
	loadSignatureSecrets()
}

func loadSignatureSecrets() {
	secretsEnv := os.Getenv("SIGNATURE_SECRETS")
	if secretsEnv == "" {
		return
	}
	pairs := strings.Split(secretsEnv, ",")
	for _, pair := range pairs {
		kv := strings.SplitN(strings.TrimSpace(pair), ":", 2)
		if len(kv) == 2 {
			signatureSecrets[kv[0]] = kv[1]
		}
	}
}

func isSignatureEnabled() bool {
	return signatureEnabled && len(signatureSecrets) > 0
}

func GetSignatureSecrets() map[string]string {
	return signatureSecrets
}

func SetSignatureSecrets(secrets map[string]string) {
	signatureSecrets = secrets
}

func SetSignatureEnabled(enabled bool) {
	signatureEnabled = enabled
}

type SignatureData struct {
	Timestamp int64
	Method    string
	Path      string
	BodyHash  string
}

func ComputeHMAC(data string, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func VerifyHMAC(expected, actual string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func HashBody(body []byte) string {
	if len(body) == 0 {
		return sha256EmptyString
	}
	h := sha256.New()
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

var sha256EmptyString = fmt.Sprintf("%x", sha256.Sum256(nil))

func GenerateSignature(data SignatureData, secret string) string {
	signatureBase := fmt.Sprintf("%d%s%s%s",
		data.Timestamp,
		data.Method,
		data.Path,
		data.BodyHash,
	)
	return ComputeHMAC(signatureBase, secret)
}

func VerifySignature(data SignatureData, signature, secret string) bool {
	expected := GenerateSignature(data, secret)
	return VerifyHMAC(expected, signature)
}

func ValidateTimestamp(timestamp int64) bool {
	requestTime := time.Unix(timestamp, 0)
	now := time.Now()
	return !requestTime.After(now) && now.Sub(requestTime) <= SignatureValidity && requestTime.Before(now.Add(1*time.Minute))
}

func RequireSignatureVerification() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isSignatureEnabled() {
			c.Next()
			return
		}

		if c.Request.Method == "OPTIONS" {
			c.Next()
			return
		}

		signature := c.GetHeader(SignatureHeader)
		timestampStr := c.GetHeader(TimestampHeader)
		accessKey := c.GetHeader(AccessKeyHeader)

		if signature == "" || timestampStr == "" || accessKey == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Missing signature headers",
			})
			return
		}

		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid timestamp format",
			})
			return
		}

		if !ValidateTimestamp(timestamp) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Request signature expired or timestamp is in the future",
			})
			return
		}

		secret, exists := signatureSecrets[accessKey]
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid access key",
			})
			return
		}

		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
				"error": "Failed to read request body",
			})
			return
		}

		c.Request.Body = io.NopCloser(strings.NewReader(string(body)))

		data := SignatureData{
			Timestamp: timestamp,
			Method:    c.Request.Method,
			Path:      c.Request.URL.Path,
			BodyHash:  HashBody(body),
		}

		if !VerifySignature(data, signature, secret) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid signature",
			})
			return
		}

		c.Next()
	}
}

func OptionalSignatureVerification() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isSignatureEnabled() {
			c.Next()
			return
		}

		if c.Request.Method == "OPTIONS" {
			c.Next()
			return
		}

		signature := c.GetHeader(SignatureHeader)
		timestampStr := c.GetHeader(TimestampHeader)
		accessKey := c.GetHeader(AccessKeyHeader)

		if signature == "" || timestampStr == "" || accessKey == "" {
			c.Next()
			return
		}

		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			c.Next()
			return
		}

		if !ValidateTimestamp(timestamp) {
			c.Next()
			return
		}

		secret, exists := signatureSecrets[accessKey]
		if !exists {
			c.Next()
			return
		}

		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.Next()
			return
		}

		c.Request.Body = io.NopCloser(strings.NewReader(string(body)))

		data := SignatureData{
			Timestamp: timestamp,
			Method:    c.Request.Method,
			Path:      c.Request.URL.Path,
			BodyHash:  HashBody(body),
		}

		if !VerifySignature(data, signature, secret) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid signature",
			})
			return
		}

		c.Next()
	}
}
