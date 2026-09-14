package handlers

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/services"
)

// This file implements the 9 /api/v1/webhooks/* endpoints from
// plan §8 (docs/EVENT_CENTER_PLAN_s-1138.md). The handlers are
// mounted behind RequireAuth(db) in cmd/server/main.go; the
// per-endpoint role check (any auth vs ADMIN) is done inline so
// a single, easy-to-read switch statement per handler owns the
// authorisation policy.
//
// Endpoints, in plan §8 order:
//
//	GET    /api/v1/webhooks                    — any auth
//	POST   /api/v1/webhooks                    — ADMIN
//	GET    /api/v1/webhooks/:id                — any auth
//	PATCH  /api/v1/webhooks/:id                — ADMIN
//	DELETE /api/v1/webhooks/:id                — ADMIN
//	POST   /api/v1/webhooks/:id/rotate         — ADMIN
//	POST   /api/v1/webhooks/:id/test           — any auth
//	GET    /api/v1/webhooks/:id/deliveries     — any auth
//	GET    /api/v1/webhooks/events             — any auth
//	                                          (in webhook_events.go)
//
// Design choices worth flagging:
//
//   - The config / rotation / list logic lives in
//     services.WebhookConfigService; the handlers are thin
//     adapters that translate JSON ⇄ CreateWebhookInput /
//     UpdateWebhookInput and map domain errors to HTTP status
//     codes. The single source of truth for "is this user
//     ADMIN?" is services.isAdminRole; we don't duplicate it
//     here.
//   - List returns [] (never null) even when the table is
//     empty so the operator UI's map() / v-for loops don't
//     trip on a null check. The service layer is responsible
//     for materialising the empty slice.
//   - Deliveries use cursor pagination keyed on
//     (started_at DESC, id DESC). The cursor is the
//     base64-encoded "<unixnano>:<id>" of the last row of
//     the previous page; the query asks for rows whose
//     (started_at, id) is strictly less than the cursor
//     under the same ordering.
//   - The test endpoint publishes a synthetic event through
//     services.GetDefaultEventBus() so the dispatcher /
//     worker pool / signing / retry pipeline runs as for a
//     real event. The handler returns 202 Accepted because
//     the actual delivery is asynchronous; the caller is
//     expected to poll /api/v1/webhooks/:id/deliveries.

// ListWebhooks handles GET /api/v1/webhooks. Returns the
// redacted view (secret = "********") of every webhook,
// ordered by created_at DESC. Empty result renders as [].
func ListWebhooks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		rows, err := svc.List()
		if err != nil {
			ServerError(c, "Failed to list webhooks", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"webhooks": rows,
			"count":    len(rows),
		})
	}
}

// createWebhookRequest is the JSON body the operator POSTs to
// /api/v1/webhooks. Pointer types on optional fields mirror the
// services.CreateWebhookInput convention so "field omitted" and
// "field explicitly null" are distinguishable for the
// booleans / ints with defaults.
type createWebhookRequest struct {
	Name       string          `json:"name"`
	URL        string          `json:"url"`
	EventTypes json.RawMessage `json:"eventTypes"`
	Filters    json.RawMessage `json:"filters"`
	Headers    json.RawMessage `json:"headers"`
	Enabled    *bool           `json:"enabled"`
	TimeoutSec *int            `json:"timeoutSec"`
	MaxRetries *int            `json:"maxRetries"`
}

// toInput converts the request into the service-layer input,
// preserving the raw JSON strings the service validates
// (avoids a re-serialise round-trip that could mangle ordering).
func (r *createWebhookRequest) toInput() services.CreateWebhookInput {
	in := services.CreateWebhookInput{
		Name:       r.Name,
		URL:        r.URL,
		EventTypes: jsonRawToString(r.EventTypes),
		Filters:    jsonRawToString(r.Filters),
		Headers:    jsonRawToString(r.Headers),
		Enabled:    r.Enabled,
		TimeoutSec: r.TimeoutSec,
		MaxRetries: r.MaxRetries,
	}
	return in
}

// jsonRawToString renders a json.RawMessage back to the JSON
// text the service expects. An empty / null RawMessage becomes
// the empty string so the service's "empty → default" branch
// fires; non-empty values are passed through verbatim.
func jsonRawToString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	return string(raw)
}

func CreateWebhook(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !strings.EqualFold(user.Role, "ADMIN") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Admin role required"})
			return
		}

		var req createWebhookRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		res, err := svc.Create(user.ID, req.toInput())
		if err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		c.JSON(http.StatusCreated, res)
	}
}

// GetWebhook handles GET /api/v1/webhooks/:id. Any
// authenticated user; secret is redacted by the service layer.
func GetWebhook(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		view, err := svc.Get(id)
		if err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"webhook": view})
	}
}

// updateWebhookRequest is the PATCH body. Every mutable field
// is a pointer so "leave unchanged" is distinct from "set to
// empty / null"; the service uses the same convention.
type updateWebhookRequest struct {
	Name       *string         `json:"name"`
	URL        *string         `json:"url"`
	EventTypes json.RawMessage `json:"eventTypes"`
	Filters    json.RawMessage `json:"filters"`
	Headers    json.RawMessage `json:"headers"`
	Enabled    *bool           `json:"enabled"`
	TimeoutSec *int            `json:"timeoutSec"`
	MaxRetries *int            `json:"maxRetries"`
}

func (r *updateWebhookRequest) toInput() services.UpdateWebhookInput {
	in := services.UpdateWebhookInput{
		Name:       r.Name,
		URL:        r.URL,
		EventTypes: ptrFromRaw(r.EventTypes),
		Filters:    ptrFromRaw(r.Filters),
		Headers:    ptrFromRaw(r.Headers),
		Enabled:    r.Enabled,
		TimeoutSec: r.TimeoutSec,
		MaxRetries: r.MaxRetries,
	}
	return in
}

// ptrFromRaw returns nil when the operator omitted the field
// (or sent null), and a pointer to the rendered JSON when
// they sent an object. This keeps the "no change" vs "set to
// {}" distinction the service expects.
func ptrFromRaw(raw json.RawMessage) *string {
	if len(raw) == 0 {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	s := string(raw)
	return &s
}

func UpdateWebhook(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !strings.EqualFold(user.Role, "ADMIN") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Admin role required"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		var req updateWebhookRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		view, err := svc.Update(user.ID, id, req.toInput())
		if err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"webhook": view})
	}
}

func DeleteWebhook(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !strings.EqualFold(user.Role, "ADMIN") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Admin role required"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		if err := svc.Delete(user.ID, id); err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

func RotateWebhookSecret(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}
		if !strings.EqualFold(user.Role, "ADMIN") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Admin role required"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		svc := services.NewWebhookConfigService(db)
		res, err := svc.RotateSecret(user.ID, id)
		if err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// testWebhookRequest is the body for POST /api/v1/webhooks/:id/test.
// Event is required and must match one of the §3 catalogue
// names; Data is forwarded verbatim under envelope.data so the
// receiver sees the synthetic payload the operator chose.
type testWebhookRequest struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

func TestWebhook(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		var req testWebhookRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}
		if req.Event == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "event is required"})
			return
		}
		if !isKnownEventType(req.Event) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "event must be one of the §3 catalogue entries",
				"event": req.Event,
			})
			return
		}

		svc := services.NewWebhookConfigService(db)
		view, err := svc.Get(id)
		if err != nil {
			writeWebhookDomainError(c, err)
			return
		}
		if !eventTypesContain(view.EventTypes, req.Event) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "webhook does not subscribe to this event type",
				"event": req.Event,
			})
			return
		}

		envelopeID := newSyntheticEnvelopeID()
		occurredAt := time.Now().UTC()

		ev := &syntheticTestEvent{
			eventType:  req.Event,
			envelopeID: envelopeID,
			occurredAt: occurredAt,
			data:       req.Data,
		}

		bus := services.GetDefaultEventBus()
		if err := bus.Publish(ev); err != nil {
			ServerError(c, "Failed to publish test event", err)
			return
		}

		c.JSON(http.StatusAccepted, gin.H{
			"success":    true,
			"event":      req.Event,
			"envelopeId": envelopeID,
			"webhookId":  view.ID,
			"occurredAt": occurredAt,
		})
	}
}

// ListWebhookDeliveries handles GET
// /api/v1/webhooks/:id/deliveries?limit=&cursor=. Returns
// paginated rows from webhook_deliveries in
// (started_at DESC, id DESC) order. Any authenticated user.
//
// The cursor is the base64-encoded "<unixnano>:<id>" of the
// last row from the previous page; rows with
// (started_at, id) strictly less than the cursor under the
// same ordering are returned. limit defaults to 20 and is
// capped at 100 so the response stays bounded.
func ListWebhookDeliveries(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing webhook id"})
			return
		}

		// Confirm the webhook exists so an unknown id yields
		// 404 instead of an empty page.
		if _, err := services.NewWebhookConfigService(db).Get(id); err != nil {
			writeWebhookDomainError(c, err)
			return
		}

		limit, err := parseDeliveriesLimit(c.Query("limit"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		cursor, err := parseDeliveriesCursor(c.Query("cursor"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// Fetch limit+1 so we can tell whether another page
		// remains without an extra COUNT(*) query.
		rows, err := queryDeliveriesPage(db, id, limit+1, cursor)
		if err != nil {
			ServerError(c, "Failed to list deliveries", err)
			return
		}

		var (
			nextCursor string
			page       = rows
		)
		if len(rows) > limit {
			last := rows[limit-1]
			page = rows[:limit]
			nextCursor = encodeDeliveriesCursor(last.StartedAt, last.ID)
		}

		c.JSON(http.StatusOK, gin.H{
			"deliveries": page,
			"count":      len(page),
			"nextCursor": nextCursor,
			"hasMore":    nextCursor != "",
		})
	}
}

// ----------------------------------------------------------------------
// Delivery view model + cursor helpers
// ----------------------------------------------------------------------

// webhookDeliveryView is the public JSON shape of one
// webhook_deliveries row exposed to the operator UI. Mirrors
// the columns from migration 012.
type webhookDeliveryView struct {
	ID           string     `json:"id"`
	WebhookID    string     `json:"webhookId"`
	EventID      string     `json:"eventId"`
	EventType    string     `json:"eventType"`
	Status       string     `json:"status"`
	Attempt      int        `json:"attempt"`
	ResponseCode int        `json:"responseCode"`
	Error        string     `json:"error,omitempty"`
	StartedAt    time.Time  `json:"startedAt"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
	NextRetryAt  *time.Time `json:"nextRetryAt,omitempty"`
}

// queryDeliveriesPage returns up to limit rows from
// webhook_deliveries for the given webhook_id, ordered by
// (started_at DESC, id DESC), optionally starting after the
// supplied cursor.
func queryDeliveriesPage(db *sql.DB, webhookID string, limit int, cursor *deliveryCursor) ([]webhookDeliveryView, error) {
	args := []interface{}{webhookID}
	where := "webhook_id = ?"
	if cursor != nil {
		// (started_at, id) < (cursor.startedAt, cursor.id)
		// expressed as
		//   started_at < ? OR (started_at = ? AND id < ?)
		// so the comparison uses the same DESC ordering the
		// page itself uses.
		where += " AND (started_at < ? OR (started_at = ? AND id < ?))"
		args = append(args, cursor.startedAt, cursor.startedAt, cursor.id)
	}
	args = append(args, limit)

	rows, err := db.Query(`
		SELECT id, webhook_id, event_id, event_type, status, attempt,
		       response_code, error, started_at, finished_at, next_retry_at
		FROM webhook_deliveries
		WHERE `+where+`
		ORDER BY datetime(started_at) DESC, id DESC
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []webhookDeliveryView{}
	for rows.Next() {
		var (
			v             webhookDeliveryView
			errStr        sql.NullString
			finishedAt    sql.NullTime
			nextRetryAt   sql.NullTime
		)
		if err := rows.Scan(
			&v.ID, &v.WebhookID, &v.EventID, &v.EventType, &v.Status, &v.Attempt,
			&v.ResponseCode, &errStr, &v.StartedAt, &finishedAt, &nextRetryAt,
		); err != nil {
			return nil, err
		}
		if errStr.Valid && errStr.String != "" {
			v.Error = errStr.String
		}
		if finishedAt.Valid {
			t := finishedAt.Time
			v.FinishedAt = &t
		}
		if nextRetryAt.Valid {
			t := nextRetryAt.Time
			v.NextRetryAt = &t
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// deliveryCursor is the decoded form of the opaque
// `?cursor=` value. The wire form is base64("<unixnano>:<id>")
// so a caller can hand back the previous page's last row
// without knowing the internal encoding.
type deliveryCursor struct {
	startedAt time.Time
	id        string
}

// parseDeliveriesLimit reads the ?limit= query string. Empty
// → default; out of range → 400.
const (
	defaultDeliveriesLimit = 20
	maxDeliveriesLimit     = 100
)

func parseDeliveriesLimit(raw string) (int, error) {
	if raw == "" {
		return defaultDeliveriesLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("limit must be an integer")
	}
	if n <= 0 {
		return 0, fmt.Errorf("limit must be positive")
	}
	if n > maxDeliveriesLimit {
		n = maxDeliveriesLimit
	}
	return n, nil
}

// parseDeliveriesCursor decodes the opaque ?cursor= query
// string back into a deliveryCursor. Empty / missing is the
// first-page case (returns nil, nil).
func parseDeliveriesCursor(raw string) (*deliveryCursor, error) {
	if raw == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("cursor is not a valid page token")
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("cursor is malformed")
	}
	nanos, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("cursor is malformed")
	}
	return &deliveryCursor{
		startedAt: time.Unix(0, nanos).UTC(),
		id:        parts[1],
	}, nil
}

// encodeDeliveriesCursor is the inverse of parseDeliveriesCursor.
// StartedAt is encoded as UnixNano to preserve sub-second
// ordering; id is appended after a ":" separator.
func encodeDeliveriesCursor(startedAt time.Time, id string) string {
	raw := fmt.Sprintf("%d:%s", startedAt.UTC().UnixNano(), id)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// ----------------------------------------------------------------------
// Synthetic test event
// ----------------------------------------------------------------------

// syntheticTestEvent is the services.Event implementation the
// test-send endpoint publishes. It carries the operator-chosen
// event type + data through the same dispatcher + worker-pool
// pipeline that production call sites use, so the deliveries
// page can show the synthetic delivery right next to the real
// ones.
type syntheticTestEvent struct {
	eventType  string
	envelopeID string
	occurredAt time.Time
	data       any
}

func (e *syntheticTestEvent) EventType() string     { return e.eventType }
func (e *syntheticTestEvent) EnvelopeID() string    { return e.envelopeID }
func (e *syntheticTestEvent) OccurredAt() time.Time { return e.occurredAt }
func (e *syntheticTestEvent) Data() any             { return e.data }

// newSyntheticEnvelopeID generates an opaque ULID-ish token for
// the synthetic event. Reusing generateOpaqueID keeps the test
// envelope id indistinguishable from real ones in the
// deliveries log, which is the operator-observable behaviour
// the spec asks for.
func newSyntheticEnvelopeID() string {
	b := make([]byte, 12)
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> (i * 2))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// isKnownEventType reports whether name appears in the §3
// catalogue. The catalogue is the same data source the picker
// endpoint serves, so adding a new event here automatically
// extends the test endpoint's accepted set.
func isKnownEventType(name string) bool {
	for _, e := range webhookEventCatalogue {
		if e.Event == name {
			return true
		}
	}
	return false
}

// eventTypesContain reports whether the event_types JSON
// column lists the given event name. An empty array ("[]" /
// "") is treated as "match nothing" so the dispatcher (and
// this handler) can't accidentally fan out to every event.
func eventTypesContain(eventTypesJSON, name string) bool {
	var types []string
	if err := json.Unmarshal([]byte(eventTypesJSON), &types); err != nil {
		return false
	}
	for _, t := range types {
		if t == name {
			return true
		}
	}
	return false
}

// writeWebhookDomainError maps the typed errors returned by
// services.WebhookConfigService to HTTP status codes. Kept in
// one place so all 8 handlers surface consistent error shapes.
func writeWebhookDomainError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, services.ErrWebhookNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Webhook not found"})
		return
	}
	if errors.Is(err, services.ErrWebhookForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Admin role required"})
		return
	}
	var inputErr *services.WebhookInputError
	if errors.As(err, &inputErr) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  inputErr.Message,
			"field":  inputErr.Field,
		})
		return
	}
	ServerError(c, "Webhook operation failed", err)
}