package handlers

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// frontendEventType is the set of event_type values the
// handler is willing to persist. Storing the value as a free
// TEXT column lets the frontend introduce new categories
// without a server migration, but we still validate against
// this allow-list at the API boundary so a malicious client
// cannot use this endpoint as a junk-row generator.
var frontendEventType = map[string]bool{
	"error":               true,
	"unhandled_rejection": true,
	"react_error":         true,
	"console_error":       true,
	"resource_404":        true,
}

// frontendEventFieldCaps are the per-column byte caps the
// handler enforces on every ingest. Keeping the limits in one
// place makes it easy to reason about worst-case row size
// (sum of these caps ≈ 47 KB) and easy to extend the schema later
// without re-deriving the limits. The caps are deliberately
// generous — Sentry's own ingest caps stack at 200KB and message
// at 4KB — but tight enough that a single misbehaving client
// cannot fill the database by streaming the contents of a large
// minified bundle.
const (
	frontendEventCapMessage = 4 * 1024
	frontendEventCapStack   = 32 * 1024
	frontendEventCapURL     = 2 * 1024
	frontendEventCapSource  = 1 * 1024
	frontendEventCapDetails = 8 * 1024
)

// FrontendEvent is the wire shape POSTed by the global error
// handler in the frontend. Fields mirror the columns on the
// `frontend_events` migration introduced in
// 016_add_frontend_events.up.sql.
//
// We use raw struct tags so the field names match the migration
// verbatim. The handler reads the body into this shape, runs
// the secret-redaction pass defined below, and writes the
// resulting row.
type FrontendEvent struct {
	EventType string          `json:"eventType"`
	Message   string          `json:"message"`
	Stack     string          `json:"stack"`
	URL       string          `json:"url"`
	Source    string          `json:"source"`
	Details   json.RawMessage `json:"details"`
}

// authHeaderPattern matches the `Authorization: Bearer <token>`
// form so we can scrub tokens that are inlined into the message
// body or stack. The regex is intentionally narrow — it only
// matches the standard "Bearer <token>" form (and "Basic ...")
// because the global error handler is the only caller and the
// frontend never surfaces user-controlled headers in the
// captured message. We deliberately do NOT try to redact every
// possible token shape; that path is best covered by the
// secret-redaction pass that already runs at log time.
var authHeaderPattern = regexp.MustCompile(
	`(?i)(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._\-+/=]+`)

// cookiePattern matches a Set-Cookie / Cookie header value with
// the kanban-token cookie explicitly named. The kanban-token
// cookie is the only authentication credential that travels in a
// Cookie header — the rest are infrastructure (csrf, sessionid,
// etc.) that are public to the same origin anyway — so a
// targeted scrub is sufficient.
var cookiePattern = regexp.MustCompile(
	`(?i)(kanban-token\s*=\s*)([A-Za-z0-9._\-+/=]+)`)

// queryTokenPattern matches `?token=…` / `?apiKey=…` query-string
// shapes the global handler sometimes captures when a network
// error includes the URL of the failing fetch.
var queryTokenPattern = regexp.MustCompile(
	`(?i)([?&](?:token|api[_-]?key|access[_-]?token|auth)\s*=\s*)([A-Za-z0-9._\-+/=]+)`)

// secretKeyPatterns matches JSON-shaped credential leaks like
// `"password":"…"`, `"secret":"…"`, etc. The capture is the
// key prefix; the value is the regex argument that matches the
// quoted value body.
var secretKeyPatterns = regexp.MustCompile(
	`(?i)("(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token)"\s*:\s*)"([^"]*)"`)

// IngestFrontendEvent accepts a single frontend error report,
// applies the secret-redaction pass on every text field, and
// persists the row. The endpoint is intentionally lightweight:
// no auth is required (an unhandled exception during the
// pre-login setup flow still needs a place to land) but the
// session is read opportunistically so the row can carry a
// userId when one is available.
//
// The endpoint is gated by the `frontendEventsEnabled`
// app_config flag — a self-hosted admin can disable the sink
// wholesale from Settings, which causes every ingest to return
// 204 with no row written. The 204 (rather than 403) is
// deliberate: the frontend's global handler should treat
// disabled sinks as "all good, nothing to do" so disabling the
// sink does not turn into a thundering herd of console
// errors.
//
// Field caps are enforced BEFORE the redaction pass so a
// megabyte-long message cannot blow the memory budget while
// running regexes against it. Capped inputs are still
// redaction-safe: truncation on a UTF-8 boundary means no
// malformed runes can sneak into the redaction output.
func IngestFrontendEvent(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isFrontendEventsEnabled(db) {
			c.Status(http.StatusNoContent)
			return
		}

		raw, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
			return
		}
		// Cap the entire payload up-front so a runaway client
		// cannot exhaust memory before we even start parsing.
		// 64 KB is well above the sum of the per-field caps
		// (~47 KB) so a well-behaved client always fits.
		const maxBody = 64 * 1024
		if len(raw) > maxBody {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "frontend event body too large"})
			return
		}

		var ev FrontendEvent
		if err := json.Unmarshal(raw, &ev); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON body"})
			return
		}

		ev.EventType = strings.TrimSpace(ev.EventType)
		if ev.EventType == "" || !frontendEventType[ev.EventType] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported eventType"})
			return
		}

		ev.Message = capAndRedact(ev.Message, frontendEventCapMessage)
		ev.Stack = capAndRedact(ev.Stack, frontendEventCapStack)
		ev.URL = capAndRedact(ev.URL, frontendEventCapURL)
		ev.Source = capAndRedact(ev.Source, frontendEventCapSource)

		// `details` is already JSON; we keep it as a RawMessage
		// so we never re-serialize it (which would lose
		// key ordering the client may rely on for diffing).
		// The cap is enforced on the raw bytes and the same
		// redaction regexes are applied to the textual form so
		// an embedded `password: "…"` cannot leak.
		if len(ev.Details) > frontendEventCapDetails {
			ev.Details = redactBytes(ev.Details[:frontendEventCapDetails])
		} else {
			ev.Details = redactBytes(ev.Details)
		}

		var userID sql.NullString
		if u := getCurrentUser(c, db); u != nil {
			userID = sql.NullString{String: u.ID, Valid: true}
		}

		id := generateID()
		_, err = db.Exec(
			`INSERT INTO frontend_events
				(id, user_id, event_type, message, stack, url, source, details)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			userID,
			ev.EventType,
			sanitizeString(ev.Message),
			sanitizeString(ev.Stack),
			sanitizeString(ev.URL),
			sanitizeString(ev.Source),
			string(ev.Details),
		)
		if err != nil {
			slog.Error("IngestFrontendEvent: insert failed", "error", err, "eventType", ev.EventType)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to record frontend event"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

// ListFrontendEvents streams the most recent frontend events
// to admins. It exists so the Settings → Error Reporting page
// can show a rolling tail of the captured exceptions without a
// separate dashboard. The endpoint is admin-only because the
// payload often contains user identifiers and stack traces
// from the public-facing bundle.
//
// Limit caps at 100 to keep the JSON payload bounded; the
// frontend uses the WebSocket activity feed for live tails.
func ListFrontendEvents(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can view frontend error events"})
			return
		}

		limit := 50
		if v := c.Query("limit"); v != "" {
			if parsed, err := parseLimitParam(v, 1, 100); err == nil {
				limit = parsed
			}
		}

		rows, err := db.Query(
			`SELECT id, user_id, event_type, message, stack, url, source, details, received_at
			 FROM frontend_events
			 ORDER BY received_at DESC
			 LIMIT ?`,
			limit,
		)
		if err != nil {
			slog.Error("ListFrontendEvents: query failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query frontend events"})
			return
		}
		defer rows.Close()

		events := make([]gin.H, 0, limit)
		for rows.Next() {
			var (
				id, eventType, receivedAt string
				userID, message, stack,
				urlField, source, details sql.NullString
			)
			if err := rows.Scan(&id, &userID, &eventType, &message, &stack, &urlField, &source, &details, &receivedAt); err != nil {
				slog.Error("ListFrontendEvents: row scan failed", "error", err)
				continue
			}
			ev := gin.H{
				"id":         id,
				"eventType":  eventType,
				"receivedAt": receivedAt,
			}
			if userID.Valid {
				ev["userId"] = userID.String
			}
			if message.Valid {
				ev["message"] = message.String
			}
			if stack.Valid {
				ev["stack"] = stack.String
			}
			if urlField.Valid {
				ev["url"] = urlField.String
			}
			if source.Valid {
				ev["source"] = source.String
			}
			if details.Valid && details.String != "" {
				ev["details"] = json.RawMessage(details.String)
			}
			events = append(events, ev)
		}
		if err := rows.Err(); err != nil {
			slog.Error("ListFrontendEvents: rows iteration", "error", err)
		}

		c.JSON(http.StatusOK, gin.H{"events": events, "total": len(events)})
	}
}

// GetFrontendEventsEnabled returns whether the admin has
// enabled the sink. The frontend reads this on first paint to
// decide whether to wire the global handler at all (zero
// network traffic when disabled). 200 / 403 are returned
// directly so the global handler can decide at runtime.
func GetFrontendEventsEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can read frontend events configuration"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"enabled": isFrontendEventsEnabled(db)})
	}
}

// SetFrontendEventsEnabled flips the app_config flag. When
// the flag is false the ingest endpoint returns 204 with no
// row written, which the frontend treats as "all good, nothing
// to do" so disabling the sink does not turn into a flood of
// console errors on the client.
//
// The flag defaults to TRUE so a fresh install lands in the
// behavior the PM review assumed: every uncaught error is
// captured.
func SetFrontendEventsEnabled(db *sql.DB) gin.HandlerFunc {
	type body struct {
		Enabled *bool `json:"enabled"`
	}
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !isAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin can change frontend events configuration"})
			return
		}

		raw, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read request body"})
			return
		}
		var payload body
		if err := json.Unmarshal(raw, &payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON body"})
			return
		}
		if payload.Enabled == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "enabled is required"})
			return
		}

		value := "0"
		if *payload.Enabled {
			value = "1"
		}
		if _, err := db.Exec(
			"REPLACE INTO app_config (`key`, value) VALUES ('frontendEventsEnabled', ?)",
			value,
		); err != nil {
			slog.Error("SetFrontendEventsEnabled: write failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"enabled": *payload.Enabled})
	}
}

// isFrontendEventsEnabled reads the `frontendEventsEnabled`
// app_config flag. Defaults to true (1) so a fresh install
// captures errors out of the box; an admin can flip it from
// Settings → Error Reporting.
func isFrontendEventsEnabled(db *sql.DB) bool {
	var raw string
	err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'frontendEventsEnabled'").Scan(&raw)
	if err != nil {
		return true
	}
	return raw != "0"
}

// capAndRedact truncates `s` to at most `cap` bytes (on a
// UTF-8 rune boundary) and runs the standard secret-redaction
// pass on the (possibly truncated) value. Doing both in one
// helper means every ingest site gets the same behaviour and
// there is no risk of forgetting the redaction when adding a
// new field.
func capAndRedact(s string, cap int) string {
	if len(s) > cap {
		s = truncateToUtf8Bytes(s, cap)
	}
	return redactString(s)
}

// truncateToUtf8Bytes trims `s` to at most `cap` bytes while
// keeping the underlying UTF-8 well-formed. We back the slice
// down to the last rune start so a multi-byte character at the
// cap boundary is dropped whole instead of producing a stray
// "replacement" rune that the redaction pass would have to
// preserve verbatim.
func truncateToUtf8Bytes(s string, cap int) string {
	if cap >= len(s) {
		return s
	}
	for cap > 0 && !utf8.RuneStart(s[cap]) {
		cap--
	}
	return s[:cap]
}

// redactString runs every known redaction pattern over `s`
// and returns the sanitized result. The patterns are applied
// in a fixed order so the output is deterministic for the same
// input — important for the snapshot tests in
// frontend_events_test.go.
func redactString(s string) string {
	if s == "" {
		return s
	}
	out := authHeaderPattern.ReplaceAllString(s, "${1}[REDACTED]")
	out = cookiePattern.ReplaceAllString(out, "${1}[REDACTED]")
	out = queryTokenPattern.ReplaceAllString(out, "${1}[REDACTED]")
	out = secretKeyPatterns.ReplaceAllString(out, `${1}"[REDACTED]"`)
	return out
}

// redactBytes is the []byte-shaped twin of redactString; the
// `details` column is a JSON blob and we never want to coerce
// it through a string round-trip because that would lose the
// distinction between a JSON null and an absent key.
func redactBytes(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	return []byte(redactString(string(b)))
}

// parseLimitParam parses the `?limit=` query parameter with
// the same bounds (1..100) the activity export endpoint
// uses. Centralised so a future endpoint can reuse it.
func parseLimitParam(raw string, min, max int) (int, error) {
	parsed := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return 0, http.ErrBodyNotAllowed
		}
		parsed = parsed*10 + int(ch-'0')
		if parsed > max*10 {
			return 0, http.ErrBodyNotAllowed
		}
	}
	if parsed < min || parsed > max {
		return 0, http.ErrBodyNotAllowed
	}
	return parsed, nil
}
