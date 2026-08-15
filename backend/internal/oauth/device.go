package oauth

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

// Device flow configuration keys & defaults (read once per request from
// app_config; missing keys fall back to defaults).
const (
	defaultDeviceCodeTTLSeconds  = 600
	defaultDevicePollIntervalSec = 5
	defaultAccessTokenTTLSeconds = 3600
	defaultRefreshTokenTTLSeconds = 2592000
	defaultAuthCodeTTLSeconds    = 120
	defaultPKCERequired          = "1"
	defaultDCREnabled            = "1"
)

// DeviceCodeRequest is the RFC 8628 §3.1 request body.
type DeviceCodeRequest struct {
	ClientID string `json:"client_id" form:"client_id"`
	Scope    string `json:"scope" form:"scope"`
}

// RequestDeviceCode handles POST /oauth/device/code. It validates the client
// and scope, generates a device_code and a human-readable user_code, and
// returns the RFC 8628 §3.2 response.
func RequestDeviceCode(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientID := c.PostForm("client_id")
		scope := c.PostForm("scope")
		if clientID == "" {
			// Allow JSON bodies for symmetry with /oauth/register.
			var req DeviceCodeRequest
			if err := c.ShouldBindJSON(&req); err == nil && req.ClientID != "" {
				clientID = req.ClientID
				scope = req.Scope
			}
		}
		if clientID == "" {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_request",
				ErrorDescription: "client_id is required",
			})
			return
		}

		client, err := GetClient(db, clientID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
					Error:            "invalid_client",
					ErrorDescription: "unknown client_id",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error: "server_error", ErrorDescription: err.Error(),
			})
			return
		}

		if !ClientAllowsGrant(client, GrantTypeDeviceCode) {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "unauthorized_client",
				ErrorDescription: "client not allowed to use device_code grant",
			})
			return
		}

		if scope != "" && !ClientAllowsScope(client, scope) {
			c.JSON(http.StatusBadRequest, models.OAuthErrorResponse{
				Error:            "invalid_scope",
				ErrorDescription: "requested scope exceeds client registration",
			})
			return
		}
		if scope == "" {
			scope = strings.Join(client.Scopes, " ")
		}
		if scope == "" {
			scope = strings.Join(SupportedScopes(), " ")
		}

		// Tokens used only once.
		deviceCode, err := randomURLSafeToken(40)
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error: "server_error", ErrorDescription: err.Error(),
			})
			return
		}
		userCode, err := generateUserCode()
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error: "server_error", ErrorDescription: err.Error(),
			})
			return
		}

		ttl := readIntConfig(db, "oauth_device_code_ttl_seconds", defaultDeviceCodeTTLSeconds)
		interval := readIntConfig(db, "oauth_device_poll_interval_seconds", defaultDevicePollIntervalSec)
		if interval < 1 {
			interval = 1
		}

		rowID := generateOpaqueID()
		expiresAt := time.Now().Add(time.Duration(ttl) * time.Second)

		_, err = db.Exec(
			`INSERT INTO oauth_device_codes
				(id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
				 expires_at, interval_seconds, status, verification_uri, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			rowID, HashToken(deviceCode), HashToken(userCode), userCode, clientID, scope,
			expiresAt, interval, verificationURIFromContext(c), time.Now(),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.OAuthErrorResponse{
				Error: "server_error", ErrorDescription: err.Error(),
			})
			return
		}

		issuer := DiscoveryIssuerFromRequest(c)
		verificationURI := issuer + "/oauth/device"
		verificationURIComplete := verificationURI + "?user_code=" + userCode

		c.JSON(http.StatusOK, models.DeviceAuthorizationResponse{
			DeviceCode:              deviceCode,
			UserCode:                userCode,
			VerificationURI:         verificationURI,
			VerificationURIComplete: verificationURIComplete,
			ExpiresIn:               int64(ttl),
			Interval:                interval,
		})
	}
}

// verificationURIFromContext builds the public path the user visits.
func verificationURIFromContext(c *gin.Context) string {
	issuer := DiscoveryIssuerFromRequest(c)
	return issuer + "/oauth/device"
}

// generateUserCode returns an 8-char human-friendly code in "XXXX-XXXX" form
// using a confusable-free alphabet (no 0/O/1/I).
func generateUserCode() (string, error) {
	const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, 9)
	for i := 0; i < 8; i++ {
		out[i+(i/4)] = alphabet[int(buf[i])%len(alphabet)]
		if i == 3 {
			out[i+1] = '-'
		}
	}
	return string(out), nil
}

// GenerateUserCodeForTest exposes generateUserCode for white-box tests.
func GenerateUserCodeForTest() (string, error) { return generateUserCode() }

// randomURLSafeToken returns a base64url string with n random bytes of entropy.
func randomURLSafeToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64URLNoPad(buf), nil
}

func base64URLNoPad(b []byte) string {
	const enc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	out := make([]byte, 0, ((len(b)+2)/3)*4)
	i := 0
	for ; i+3 <= len(b); i += 3 {
		v := uint32(b[i])<<16 | uint32(b[i+1])<<8 | uint32(b[i+2])
		out = append(out, enc[(v>>18)&0x3F], enc[(v>>12)&0x3F], enc[(v>>6)&0x3F], enc[v&0x3F])
	}
	switch len(b) - i {
	case 1:
		v := uint32(b[i]) << 16
		out = append(out, enc[(v>>18)&0x3F], enc[(v>>12)&0x3F])
	case 2:
		v := uint32(b[i])<<16 | uint32(b[i+1])<<8
		out = append(out, enc[(v>>18)&0x3F], enc[(v>>12)&0x3F], enc[(v>>6)&0x3F])
	}
	return string(out)
}

// readIntConfig fetches an integer-valued app_config key, falling back to def.
func readIntConfig(db *sql.DB, key string, def int) int {
	var raw string
	if err := db.QueryRow("SELECT value FROM app_config WHERE `key` = ?", key).Scan(&raw); err != nil {
		return def
	}
	n := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return def
		}
		n = n*10 + int(ch-'0')
	}
	if n <= 0 {
		return def
	}
	return n
}

// ApproveDeviceCode marks a device code as approved by the given user. Returns
// the stored device_code_hash (for the approval UI) and the persisted scope.
//
// The approval UI submits the user-facing user_code (display) over the
// browser; this function hashes it to find the row.
func ApproveDeviceCode(db *sql.DB, userCode string, userID string) (*models.OAuthDeviceCode, error) {
	dc, err := findDeviceCodeByUserCode(db, userCode)
	if err != nil {
		return nil, err
	}
	if dc.Status != "pending" {
		return nil, fmt.Errorf("device code status is %s", dc.Status)
	}
	if dc.ExpiresAt.Before(time.Now()) {
		_, _ = db.Exec("UPDATE oauth_device_codes SET status = 'expired' WHERE id = ?", dc.ID)
		return nil, errors.New("device code expired")
	}
	_, err = db.Exec("UPDATE oauth_device_codes SET status = 'approved', user_id = ? WHERE id = ?", userID, dc.ID)
	if err != nil {
		return nil, err
	}
	dc.Status = "approved"
	dc.UserID = &userID
	return dc, nil
}

// DenyDeviceCode flips the device code to denied and records the user.
func DenyDeviceCode(db *sql.DB, userCode string, userID string) error {
	dc, err := findDeviceCodeByUserCode(db, userCode)
	if err != nil {
		return err
	}
	if dc.Status != "pending" {
		return fmt.Errorf("device code already %s", dc.Status)
	}
	_, err = db.Exec("UPDATE oauth_device_codes SET status = 'denied', user_id = ? WHERE id = ?", userID, dc.ID)
	return err
}

// findDeviceCodeByUserCode returns the device code row matching the displayed
// user_code. Uses constant-time comparison on the hash.
func findDeviceCodeByUserCode(db *sql.DB, userCode string) (*models.OAuthDeviceCode, error) {
	target := HashToken(strings.ToUpper(strings.TrimSpace(userCode)))
	rows, err := db.Query(
		`SELECT id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
		        expires_at, interval_seconds, last_poll_at, status, user_id, verification_uri, created_at
		 FROM oauth_device_codes WHERE status = 'pending'`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var dc models.OAuthDeviceCode
		var lastPoll sql.NullTime
		var userID sql.NullString
		if err := rows.Scan(&dc.ID, &dc.DeviceCodeHash, &dc.UserCodeHash, &dc.UserCodeDisplay, &dc.ClientID,
			&dc.Scope, &dc.ExpiresAt, &dc.IntervalSeconds, &lastPoll, &dc.Status,
			&userID, &dc.VerificationURI, &dc.CreatedAt); err != nil {
			return nil, err
		}
		if subtle.ConstantTimeCompare([]byte(dc.UserCodeHash), []byte(target)) == 1 {
			if lastPoll.Valid {
				t := lastPoll.Time
				dc.LastPollAt = &t
			}
			if userID.Valid {
				s := userID.String
				dc.UserID = &s
			}
			return &dc, nil
		}
	}
	return nil, sql.ErrNoRows
}

// FindDeviceCodeByDeviceToken returns the device row whose device_code_hash
// matches the supplied device_code string.
func FindDeviceCodeByDeviceToken(db *sql.DB, deviceCode string) (*models.OAuthDeviceCode, error) {
	target := HashToken(deviceCode)
	row := db.QueryRow(
		`SELECT id, device_code_hash, user_code_hash, user_code_display, client_id, scope,
		        expires_at, interval_seconds, last_poll_at, status, user_id, verification_uri, created_at
		 FROM oauth_device_codes WHERE device_code_hash = ?`,
		target,
	)
	var dc models.OAuthDeviceCode
	var lastPoll sql.NullTime
	var userID sql.NullString
	if err := row.Scan(&dc.ID, &dc.DeviceCodeHash, &dc.UserCodeHash, &dc.UserCodeDisplay, &dc.ClientID,
		&dc.Scope, &dc.ExpiresAt, &dc.IntervalSeconds, &lastPoll, &dc.Status,
		&userID, &dc.VerificationURI, &dc.CreatedAt); err != nil {
		return nil, err
	}
	if lastPoll.Valid {
		t := lastPoll.Time
		dc.LastPollAt = &t
	}
	if userID.Valid {
		s := userID.String
		dc.UserID = &s
	}
	return &dc, nil
}

// MarkDevicePolled records the last poll time on the device code row.
func MarkDevicePolled(db *sql.DB, id string) error {
	_, err := db.Exec("UPDATE oauth_device_codes SET last_poll_at = ? WHERE id = ?", time.Now(), id)
	return err
}

// readJSONArray tolerates both string and JSON-array-shaped fields.
func readJSONArray(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}