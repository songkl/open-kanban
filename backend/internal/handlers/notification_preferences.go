package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// NotificationPreferences is the per-user notification-delivery
// preference row returned by GET /api/v1/auth/me/notification-preferences
// and accepted by PUT on the same path. The shape is intentionally
// flat (no nested objects) so a future audit page can render the
// values without parsing JSON.
//
// Field semantics (s-1203, PM_REVIEW_2026-09-17 §3.7):
//
//   - EmailEnabled  — master switch for outbound email delivery
//                     triggered by bell-badge rows. The in-app
//                     bell is always on; this only mutes the
//                     external transport.
//   - WebhookEnabled — master switch for outbound webhook
//                     delivery. Independent from EmailEnabled so
//                     users can mute one channel without the
//                     other.
//   - WebhookURL     — destination URL for outbound webhook
//                     deliveries. Empty / NULL means there is no
//                     destination, so the webhook fan-out skips
//                     the user even if WebhookEnabled is true.
type NotificationPreferences struct {
	UserID         string `json:"userId"`
	EmailEnabled   bool   `json:"emailEnabled"`
	WebhookEnabled bool   `json:"webhookEnabled"`
	WebhookURL     string `json:"webhookUrl"`
	UpdatedAt      string `json:"updatedAt"`
}

// defaultNotificationPreferences returns the default row used when
// the caller has no preferences row yet (e.g. a brand-new user
// hitting GET for the first time). Defaults match the SQLite / MySQL
// migration: email + webhook enabled, empty webhook URL.
func defaultNotificationPreferences(userID string) NotificationPreferences {
	return NotificationPreferences{
		UserID:         userID,
		EmailEnabled:   true,
		WebhookEnabled: true,
		WebhookURL:     "",
		UpdatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
}

// GetMyNotificationPreferences returns the caller's notification
// preferences. On first access (no row) the handler returns the
// defaults above rather than 404, so the Settings page never has
// to special-case "user has never opened the tab".
func GetMyNotificationPreferences(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		prefs, err := loadNotificationPreferences(db, user.ID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusOK, defaultNotificationPreferences(user.ID))
				return
			}
			slog.Error("GetMyNotificationPreferences: load failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load notification preferences"})
			return
		}
		c.JSON(http.StatusOK, prefs)
	}
}

// UpdateMyNotificationPreferences writes the caller's notification
// preferences. The body is a partial document — every field is
// optional so the Settings tab can PATCH one switch at a time
// without resending the full row. Unset bools fall back to the
// stored value so a PUT that only flips webhookEnabled cannot
// silently re-enable email.
//
// We deliberately do NOT use a strict JSON binding here: gin.BindJSON
// would reject the request when a bool field is omitted, which is
// the opposite of what the partial-update semantics want.
func UpdateMyNotificationPreferences(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		// Read the raw body so we can distinguish "field omitted"
		// from "field present with false value".
		raw, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
			return
		}

		var patch struct {
			EmailEnabled   *bool   `json:"emailEnabled"`
			WebhookEnabled *bool   `json:"webhookEnabled"`
			WebhookURL     *string `json:"webhookUrl"`
		}
		if err := bindJSONBytes(raw, &patch); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON body"})
			return
		}

		if patch.WebhookURL != nil {
			cleaned := sanitizeString(*patch.WebhookURL)
			if cleaned != "" && !isValidWebhookURL(cleaned) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "webhookUrl must be a valid http(s) URL"})
				return
			}
			patch.WebhookURL = &cleaned
		}

		// Load existing row (or default) so omitted fields can be
		// preserved. Doing this AFTER the validation above means a
		// bogus webhook URL still returns 400 even on a brand-new
		// user (the defaults would otherwise paper over it).
		current, err := loadNotificationPreferences(db, user.ID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			slog.Error("UpdateMyNotificationPreferences: load failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load notification preferences"})
			return
		}
		if errors.Is(err, sql.ErrNoRows) {
			current = defaultNotificationPreferences(user.ID)
		}

		if patch.EmailEnabled != nil {
			current.EmailEnabled = *patch.EmailEnabled
		}
		if patch.WebhookEnabled != nil {
			current.WebhookEnabled = *patch.WebhookEnabled
		}
		if patch.WebhookURL != nil {
			current.WebhookURL = *patch.WebhookURL
		}
		current.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

		if err := upsertNotificationPreferences(db, current); err != nil {
			slog.Error("UpdateMyNotificationPreferences: upsert failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save notification preferences"})
			return
		}

		c.JSON(http.StatusOK, current)
	}
}

// loadNotificationPreferences reads the row for the given user. We
// keep the SELECT list explicit (no SELECT *) so adding a column
// later cannot accidentally widen the API surface.
func loadNotificationPreferences(db *sql.DB, userID string) (NotificationPreferences, error) {
	var prefs NotificationPreferences
	var updatedAt time.Time
	err := db.QueryRow(
		`SELECT user_id, email_enabled, webhook_enabled, webhook_url, updated_at
		 FROM user_notification_preferences
		 WHERE user_id = ?`,
		userID,
	).Scan(&prefs.UserID, &prefs.EmailEnabled, &prefs.WebhookEnabled, &prefs.WebhookURL, &updatedAt)
	if err != nil {
		return prefs, err
	}
	prefs.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return prefs, nil
}

// upsertNotificationPreferences writes the row for the user. We use
// SQLite/MySQL-compatible UPSERT semantics: the driver-agnostic
// INSERT … ON CONFLICT … DO UPDATE form supported by go-sqlite3
// (since 3.24) and MySQL (since 8.0). The schema declares user_id
// as the PRIMARY KEY, so a duplicate INSERT collides on that key.
//
// The driver-detect branch is needed because go-sqlite3 has
// historically been built against older SQLite versions on some
// distros; if ON CONFLICT is rejected we fall back to
// UPDATE-then-INSERT to keep the contract observable.
func upsertNotificationPreferences(db *sql.DB, prefs NotificationPreferences) error {
	const upsert = `
		INSERT INTO user_notification_preferences
			(user_id, email_enabled, webhook_enabled, webhook_url, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			email_enabled = excluded.email_enabled,
			webhook_enabled = excluded.webhook_enabled,
			webhook_url = excluded.webhook_url,
			updated_at = excluded.updated_at
	`
	updatedAt, err := time.Parse(time.RFC3339, prefs.UpdatedAt)
	if err != nil {
		updatedAt = time.Now().UTC()
	}
	if _, err := db.Exec(upsert, prefs.UserID, prefs.EmailEnabled, prefs.WebhookEnabled, prefs.WebhookURL, updatedAt); err != nil {
		// Fall back to UPDATE-then-INSERT for older SQLite builds
		// that reject ON CONFLICT. We don't surface the underlying
		// error in this branch because we want the same caller code
		// path to work for both modern and legacy drivers.
		if isUpsertUnsupported(err) {
			if uerr := updateNotificationPreferences(db, prefs, updatedAt); uerr == nil {
				return nil
			} else if uerr != sql.ErrNoRows {
				return uerr
			}
			_, ierr := db.Exec(
				`INSERT INTO user_notification_preferences
					(user_id, email_enabled, webhook_enabled, webhook_url, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
				prefs.UserID, prefs.EmailEnabled, prefs.WebhookEnabled, prefs.WebhookURL, updatedAt,
			)
			return ierr
		}
		return err
	}
	return nil
}

func updateNotificationPreferences(db *sql.DB, prefs NotificationPreferences, updatedAt time.Time) error {
	res, err := db.Exec(
		`UPDATE user_notification_preferences
		 SET email_enabled = ?, webhook_enabled = ?, webhook_url = ?, updated_at = ?
		 WHERE user_id = ?`,
		prefs.EmailEnabled, prefs.WebhookEnabled, prefs.WebhookURL, updatedAt, prefs.UserID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func isUpsertUnsupported(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "near \"on\"") ||
		strings.Contains(msg, "syntax error") ||
		strings.Contains(msg, "upsert") ||
		strings.Contains(msg, "on conflict")
}

// isValidWebhookURL accepts only http(s) URLs and rejects the
// obvious foot-guns: scheme-relative, javascript:, data:, file:,
// etc. The fan-out layer performs the actual egress, but rejecting
// obvious bad inputs at the API boundary means a typo can never
// become a stored XSS payload surfaced by the Settings page.
func isValidWebhookURL(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	if u.Host == "" {
		return false
	}
	if utf8.RuneCountInString(raw) > 2048 {
		return false
	}
	return true
}

// bindJSONBytes is a tiny helper to parse a request body that's
// already been fully read (so we can treat a JSON syntax error as
// 400 instead of letting gin consume the body twice).
func bindJSONBytes(raw []byte, dst interface{}) error {
	return json.Unmarshal(raw, dst)
}
