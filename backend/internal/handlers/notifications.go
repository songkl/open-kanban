package handlers

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// NotificationSource enumerates the four trigger streams documented
// in PM_REVIEW_2026-09-17 §5.2 (ROI #2). Keeping the set closed at
// the schema level (CHECK constraint + Go const list) means a typo
// on the client can never produce a row that the bell badge then
// silently drops because the label doesn't match an i18n key.
const (
	NotificationSourceTaskAssigned  = "TASK_ASSIGNED"
	NotificationSourceTaskMentioned = "TASK_MENTIONED"
	NotificationSourceRunCompleted  = "RUN_COMPLETED"
	NotificationSourceWebhookFailed = "WEBHOOK_FAILED"
)

// Notification is the wire-shape returned by the GET endpoints and
// pushed over the WebSocket `new_notification` channel. Field names
// are camelCase to match the rest of the kanban API surface.
type Notification struct {
	ID         string     `json:"id"`
	UserID     string     `json:"userId"`
	Source     string     `json:"source"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	TargetType string     `json:"targetType"`
	TargetID   string     `json:"targetId"`
	ReadAt     *time.Time `json:"readAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}

// NotificationMessage is the WebSocket envelope. Mirrors the
// ActivityMessage shape used elsewhere so clients can switch on
// `message.type` with one code path.
type NotificationMessage struct {
	Type         string       `json:"type"`
	Notification Notification `json:"notification"`
}

// notificationMentionRE matches @nickname tokens in comment bodies.
// The leading "non-letter/non-digit OR start-of-string" guard is
// important: a naive `@([A-Za-z0-9_\-]+)` would consume the local
// part of an email address like `user@example.com` (matching
// `@example`), and the comment-list surface in the UI would then
// page Carol about every email-style address in her mention list.
// The "start of string" alternative keeps the regex valid when the
// mention is the first token of the comment body.
var notificationMentionRE = regexp.MustCompile(`(?:^|[^\pL\pN])@([A-Za-z0-9_\-]{1,64})`)

// InsertNotification persists a new notification row and enqueues a
// WebSocket broadcast so connected clients can refresh the bell
// badge without polling. The function is safe to call from request
// handlers (returns an error rather than panicking) but is typically
// invoked via `go InsertNotification(...)` so the originating
// request isn't held up by the WS fan-out.
//
// Parameters:
//
//   - db              — connection pool (used by INSERT and lookup).
//   - userID          — recipient. FK on users.id; ON DELETE CASCADE
//                      keeps orphan rows from accumulating when an
//                      admin removes a user.
//   - source          — one of the NotificationSource* consts; an
//                      unknown value is rejected so a typo can't
//                      silently desync the badge.
//   - title           — short headline rendered in the bell list.
//   - body            — optional supporting copy (kept under 1024
//                      chars by the regex / column).
//   - targetType      — empty or one of TASK / COMMENT / RUN / WEBHOOK.
//   - targetID        — opaque id the bell list can deep-link into.
func InsertNotification(db *sql.DB, userID, source, title, body, targetType, targetID string) error {
	if userID == "" {
		return errors.New("notifications: userID is required")
	}
	switch source {
	case NotificationSourceTaskAssigned,
		NotificationSourceTaskMentioned,
		NotificationSourceRunCompleted,
		NotificationSourceWebhookFailed:
	default:
		return errors.New("notifications: invalid source")
	}
	switch targetType {
	case "", "TASK", "COMMENT", "RUN", "WEBHOOK":
	default:
		return errors.New("notifications: invalid targetType")
	}
	title = sanitizeString(title)
	body = sanitizeString(body)
	if utf8.RuneCountInString(title) > 255 {
		title = string([]rune(title)[:255])
	}
	if utf8.RuneCountInString(body) > 1024 {
		body = string([]rune(body)[:1024])
	}

	id := generateID()
	now := time.Now()
	if _, err := db.Exec(
		`INSERT INTO notifications (id, user_id, source, title, body, target_type, target_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, userID, source, title, body, targetType, targetID, now,
	); err != nil {
		slog.Error("InsertNotification: db insert failed", "error", err, "userID", userID, "source", source)
		return err
	}

	n := Notification{
		ID:         id,
		UserID:     userID,
		Source:     source,
		Title:      title,
		Body:       body,
		TargetType: targetType,
		TargetID:   targetID,
		CreatedAt:  now,
	}
	BroadcastNotification(n)
	return nil
}

// BroadcastNotification enqueues a `new_notification` envelope on
// the WebSocket broadcast queue. The current process-level broadcast
// is global (every connected client receives every payload), so
// clients filter by `message.notification.userId` on receive. When
// per-user routing becomes necessary the WS layer can replace the
// fan-out path without touching the producer side.
func BroadcastNotification(n Notification) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Recovered from panic in BroadcastNotification", "panic", r)
		}
	}()

	envelope := NotificationMessage{
		Type:         "new_notification",
		Notification: sanitizeNotification(n),
	}
	enqueueBroadcast(websocket.TextMessage, envelope)
}

// sanitizeNotification strips invalid UTF-8 from the row so a
// pathological payload can't break a downstream WS write. The
// implementation duplicates the per-field walk (instead of reusing
// sanitizeValue) because the struct sanitizer panics when a Ptr
// field is nil — which `ReadAt` is by construction on a fresh row —
// and the existing `sanitizeActivity` path only gets called on rows
// that have already been read out of the DB. Keeping the two
// surfaces separate avoids leaking that panic into the new
// insert-time broadcast path.
func sanitizeNotification(n Notification) Notification {
	n.Title = sanitizeString(n.Title)
	n.Body = sanitizeString(n.Body)
	n.UserID = sanitizeString(n.UserID)
	n.Source = sanitizeString(n.Source)
	n.TargetType = sanitizeString(n.TargetType)
	n.TargetID = sanitizeString(n.TargetID)
	return n
}

// ExtractMentions returns the set of nicknames mentioned in the
// supplied comment body. We strip the leading `@` and match the
// project-allowed nickname charset (letters/digits/_/-) so callers
// can resolve mentions against the `users` table without needing a
// second regex.
//
// Order is preserved (first occurrence wins), and duplicates are
// collapsed. An empty body returns an empty slice, not nil, so the
// caller can `for _, m := range ExtractMentions(...)` without a
// nil-check.
func ExtractMentions(body string) []string {
	if body == "" {
		return []string{}
	}
	matches := notificationMentionRE.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return []string{}
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		nick := strings.TrimSpace(m[1])
		if nick == "" || seen[nick] {
			continue
		}
		seen[nick] = true
		out = append(out, nick)
	}
	return out
}

// ResolveUserIDsByNickname looks up the user.id for each supplied
// nickname and returns the matched (id, nickname) pairs. Unknown
// nicknames are silently skipped — the caller will simply have
// nothing to notify, which is the right behavior for typos in a
// comment body. The lookup is a single SELECT IN (...) so callers
// can hand the whole mention list in one query.
func ResolveUserIDsByNickname(db *sql.DB, nicknames []string) (map[string]string, error) {
	out := make(map[string]string)
	if len(nicknames) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(nicknames)), ",")
	args := make([]interface{}, len(nicknames))
	for i, n := range nicknames {
		args[i] = n
	}
	rows, err := db.Query(
		"SELECT id, nickname FROM users WHERE nickname IN ("+placeholders+")",
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, nick string
		if err := rows.Scan(&id, &nick); err != nil {
			return nil, err
		}
		out[id] = nick
	}
	return out, rows.Err()
}

// GetNotifications returns the notifications for the caller, newest
// first. Default page size is 50; the optional `unreadOnly=true`
// query parameter restricts the result to unread rows so the bell
// badge can hydrate from a cheap call without a separate endpoint.
//
// Response shape mirrors the activity list pattern:
//   { notifications: [...], unreadCount: N }
func GetNotifications(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		limit := 50
		if l := c.Query("limit"); l != "" {
			if parsed, err := atoiInRange(l, 1, 100); err == nil {
				limit = parsed
			}
		}
		offset := 0
		if o := c.Query("offset"); o != "" {
			if parsed, err := atoiInRange(o, 0, 10000); err == nil {
				offset = parsed
			}
		}
		unreadOnly := c.Query("unreadOnly") == "true"

		var (
			rows *sql.Rows
			err  error
		)
		if unreadOnly {
			rows, err = db.Query(
				`SELECT id, user_id, source, title, body, target_type, target_id, read_at, created_at
				 FROM notifications
				 WHERE user_id = ? AND read_at IS NULL
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
				user.ID, limit, offset,
			)
		} else {
			rows, err = db.Query(
				`SELECT id, user_id, source, title, body, target_type, target_id, read_at, created_at
				 FROM notifications
				 WHERE user_id = ?
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
				user.ID, limit, offset,
			)
		}
		if err != nil {
			slog.Error("GetNotifications: query failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query notifications"})
			return
		}
		defer rows.Close()

		out := make([]Notification, 0, limit)
		for rows.Next() {
			var n Notification
			var readAt sql.NullTime
			if err := rows.Scan(&n.ID, &n.UserID, &n.Source, &n.Title, &n.Body, &n.TargetType, &n.TargetID, &readAt, &n.CreatedAt); err != nil {
				slog.Error("GetNotifications: scan failed", "error", err)
				continue
			}
			if readAt.Valid {
				t := readAt.Time
				n.ReadAt = &t
			}
			out = append(out, n)
		}

		var unreadCount int
		if err := db.QueryRow(
			"SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
			user.ID,
		).Scan(&unreadCount); err != nil {
			slog.Error("GetNotifications: unread count failed", "error", err, "userID", user.ID)
		}

		c.JSON(http.StatusOK, gin.H{
			"notifications": out,
			"unreadCount":   unreadCount,
		})
	}
}

// MarkNotificationRead flips read_at on the supplied notification.
// Returns 404 if the row doesn't exist OR belongs to another user,
// so the endpoint can't be used to probe other users' notification
// IDs.
func MarkNotificationRead(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Notification ID is required"})
			return
		}

		now := time.Now()
		res, err := db.Exec(
			"UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
			now, id, user.ID,
		)
		if err != nil {
			slog.Error("MarkNotificationRead: update failed", "error", err, "userID", user.ID, "notificationID", id)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update notification"})
			return
		}
		rows, _ := res.RowsAffected()
		if rows == 0 {
			// Distinguish 404 (no row / not owned) from 200 (already
			// read). A SELECT lets us emit the right status without
			// leaking the existence of other users' rows.
			var ownerID string
			err := db.QueryRow("SELECT user_id FROM notifications WHERE id = ?", id).Scan(&ownerID)
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Notification not found"})
				return
			}
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update notification"})
				return
			}
			if ownerID != user.ID {
				c.JSON(http.StatusNotFound, gin.H{"error": "Notification not found"})
				return
			}
			// Already read — idempotent 200.
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "readAt": now})
	}
}

// MarkAllNotificationsRead is a single UPDATE that flips every
// unread row owned by the caller. We don't expose a DELETE because
// the audit surface (the activities table) is what records who did
// what, and the bell list intentionally retains read history so
// users can scroll back without losing context.
func MarkAllNotificationsRead(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		now := time.Now()
		if _, err := db.Exec(
			"UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
			now, user.ID,
		); err != nil {
			slog.Error("MarkAllNotificationsRead: update failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to mark notifications read"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "readAt": now})
	}
}

func atoiInRange(s string, min, max int) (int, error) {
	n := 0
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(ch-'0')
		if n > max {
			return 0, errors.New("out of range")
		}
	}
	if n < min {
		return 0, errors.New("below min")
	}
	return n, nil
}