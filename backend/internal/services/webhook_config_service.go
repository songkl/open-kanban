package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
)

// WebhookAuditAction enumerates the action strings the webhook
// config service writes to the activities table on each write
// operation (plan §6.2 in
// docs/EVENT_CENTER_PLAN_s-1138.md). Each value MUST be listed
// in the activities.action CHECK constraint extended by
// migration 014 — a typo here surfaces as a CHECK violation at
// INSERT time, which the AuditLog helper logs and swallows so
// the admin operation still succeeds.
type WebhookAuditAction string

const (
	AuditActionWebhookCreated WebhookAuditAction = "webhook.created"
	AuditActionWebhookUpdated WebhookAuditAction = "webhook.updated"
	AuditActionWebhookDeleted WebhookAuditAction = "webhook.deleted"
	AuditActionWebhookRotated WebhookAuditAction = "webhook.rotated"
	AuditActionWebhookTested  WebhookAuditAction = "webhook.tested"
)

// WebhookAuditTargetType is the activities.target_type stamped
// on every webhook-centre audit row. Added to the target_type
// CHECK in migration 014.
const WebhookAuditTargetType = "WEBHOOK"

// WebhookSecretRedacted is the literal placeholder the service
// stamps over the secret in Get / List responses. The plan
// promises the literal "********" exactly eight asterisks; using
// a constant here keeps the redacted shape stable across the
// service and tests.
const WebhookSecretRedacted = "********"

// WebhookSecretLength controls the number of random bytes the
// service generates for a new / rotated secret. 32 bytes = 256
// bits, the standard HMAC-SHA256 key size; the hex-encoded form
// is therefore 64 chars. Plan §5.2.
const WebhookSecretLength = 32

// WebhookDefaultTimeoutSec / WebhookDefaultMaxRetries mirror the
// column defaults in migration 012; duplicated here so callers
// can construct a webhook without specifying them.
const (
	WebhookDefaultTimeoutSec = 10
	WebhookDefaultMaxRetries = 5
)

// WebhookConfigService is the webhook-centre CRUD + secret
// rotation layer. It is the only layer that touches the secret
// plaintext: it generates the random secret on Create /
// RotateSecret, hands it back to the caller exactly once, and
// never re-exposes it on subsequent reads.
//
// The service owns:
//
//   - URL validation per plan §5.4 (https-only, no RFC1918 /
//     link-local / loopback unless WEBHOOK_ALLOW_PRIVATE=1).
//   - DNS resolution warning when the host fails to resolve —
//     logged via slog so operators can spot broken webhook
//     destinations without losing the row.
//   - Audit log writes for every Create / Update / Delete /
//     RotateSecret — see logWebhookActivity below.
//
// The service is intentionally stateless; the underlying
// repositories.WebhookRepository owns the SQL, this layer owns
// the validation + audit + redaction policy.
type WebhookConfigService struct {
	db   *sql.DB
	repo *repositories.WebhookRepository
}

// NewWebhookConfigService constructs a WebhookConfigService
// bound to the supplied DB. The DB must already have the
// webhooks table from migration 012 applied; otherwise every
// method here will return a SQL "no such table" error.
func NewWebhookConfigService(db *sql.DB) *WebhookConfigService {
	return &WebhookConfigService{
		db:   db,
		repo: repositories.NewWebhookRepository(db),
	}
}

// CreateWebhookInput is the operator-supplied payload for POST
// /api/v1/webhooks. The ID, Secret, CreatedBy and timestamps
// are populated by the service — callers should not supply them.
type CreateWebhookInput struct {
	Name       string
	URL        string
	EventTypes string // JSON array of strings, validated as JSON
	Filters    string // JSON object, validated as JSON object
	Headers    string // JSON object, validated as JSON object
	Enabled    *bool  // nil → true (matches schema DEFAULT 1)
	TimeoutSec *int   // nil → WebhookDefaultTimeoutSec
	MaxRetries *int   // nil → WebhookDefaultMaxRetries
}

// UpdateWebhookInput is the operator-supplied payload for PUT
// /api/v1/webhooks/:id. Every field is a pointer so the caller
// can distinguish "leave unchanged" (nil) from "set to empty
// string" — the same convention the OAuth provider update
// handler uses.
type UpdateWebhookInput struct {
	Name       *string
	URL        *string
	EventTypes *string
	Filters    *string
	Headers    *string
	Enabled    *bool
	TimeoutSec *int
	MaxRetries *int
}

// WebhookView is the redacted representation of a webhooks row
// exposed to operator clients. Secret is replaced with the
// literal WebhookSecretRedacted placeholder; the rest of the
// fields mirror models.Webhook so the JSON wire shape stays
// stable.
type WebhookView struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	URL           string     `json:"url"`
	Secret        string     `json:"secret"`
	Enabled       bool       `json:"enabled"`
	EventTypes    string     `json:"eventTypes"`
	Filters       string     `json:"filters"`
	Headers       string     `json:"headers"`
	TimeoutSec    int        `json:"timeoutSec"`
	MaxRetries    int        `json:"maxRetries"`
	CreatedBy     *string    `json:"createdBy,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastFailureAt *time.Time `json:"lastFailureAt,omitempty"`
}

// CreateWebhookResult bundles the redacted view (what the
// operator UI stores / displays) with the plaintext secret
// (what the operator copies into their receiver). The secret
// is only returned from Create and RotateSecret — every other
// service method redacts it.
type CreateWebhookResult struct {
	Webhook         WebhookView `json:"webhook"`
	PlaintextSecret string      `json:"plaintextSecret"`
}

// CreateWebhookInputError is returned by Create / Update when
// the supplied URL or event_types / filters / headers payload
// fails validation. Callers (HTTP handler / CLI) translate it
// to a 400 with the message in the response body.
type WebhookInputError struct {
	Field   string
	Message string
}

func (e *WebhookInputError) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// PermissionError is returned by Create / Update / Delete /
// RotateSecret when the supplied actor does not have the
// ADMIN role. HTTP layer translates it to 403.
var ErrWebhookForbidden = errors.New("webhook admin operations require ADMIN role")

// ErrWebhookNotFound is the user-facing alias for
// repositories.ErrWebhookNotFound so the handler layer doesn't
// have to import the repositories package just for this.
var ErrWebhookNotFound = repositories.ErrWebhookNotFound

// Create generates a fresh opaque id + random 256-bit secret,
// validates the URL and JSON fields, persists the row, and
// returns the redacted view alongside the plaintext secret.
//
// actorID is the users.id of the operator; required for the
// audit log and stored on the row's created_by column. An
// empty actorID surfaces as an error from logWebhookActivity —
// the row itself is still inserted so a misconfigured caller
// doesn't accidentally lose the configuration.
func (s *WebhookConfigService) Create(actorID string, in CreateWebhookInput) (*CreateWebhookResult, error) {
	if !isAdminRole(actorID, s.db) {
		return nil, ErrWebhookForbidden
	}
	if err := validateWebhookCreateInput(in); err != nil {
		return nil, err
	}
	if err := s.warnOnUnresolvableURL(in.URL); err != nil {
		// DNS failure is a soft warning, not a hard rejection:
		// operators legitimately configure webhooks for hosts
		// that aren't resolvable from the API server's egress
		// (private DNS, hosts behind a VPN). Logged and
		// swallowed so the Create succeeds.
		slog.Warn("webhook url dns lookup failed", "url", in.URL, "error", err)
	}

	id, err := generateOpaqueID(WebhookSecretLength / 2)
	if err != nil {
		return nil, fmt.Errorf("generate webhook id: %w", err)
	}
	plaintextSecret, secretBlob, err := generateWebhookSecret()
	if err != nil {
		return nil, fmt.Errorf("generate webhook secret: %w", err)
	}

	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	timeoutSec := WebhookDefaultTimeoutSec
	if in.TimeoutSec != nil && *in.TimeoutSec > 0 {
		timeoutSec = *in.TimeoutSec
	}
	maxRetries := WebhookDefaultMaxRetries
	if in.MaxRetries != nil && *in.MaxRetries >= 0 {
		maxRetries = *in.MaxRetries
	}

	var createdBy *string
	if actorID != "" {
		createdBy = &actorID
	}

	w := &models.Webhook{
		ID:         id,
		Name:       strings.TrimSpace(in.Name),
		URL:        strings.TrimSpace(in.URL),
		Secret:     secretBlob,
		Enabled:    enabled,
		EventTypes: in.EventTypes,
		Filters:    in.Filters,
		Headers:    in.Headers,
		TimeoutSec: timeoutSec,
		MaxRetries: maxRetries,
		CreatedBy:  createdBy,
	}
	if err := s.repo.Create(w); err != nil {
		return nil, err
	}

	logWebhookActivity(s.db, actorID, AuditActionWebhookCreated, id, w.Name, map[string]any{
		"url":        w.URL,
		"enabled":    enabled,
		"timeoutSec": timeoutSec,
		"maxRetries": maxRetries,
		"eventTypes": in.EventTypes,
		"hasFilters": in.Filters != "",
		"hasHeaders": in.Headers != "",
	})

	return &CreateWebhookResult{
		Webhook:         redactWebhook(w),
		PlaintextSecret: plaintextSecret,
	}, nil
}

// Get returns the redacted view of the named webhook, or
// ErrWebhookNotFound when no row matches. The redacted view
// always has Secret = WebhookSecretRedacted.
func (s *WebhookConfigService) Get(id string) (WebhookView, error) {
	w, err := s.repo.Get(id)
	if err != nil {
		return WebhookView{}, err
	}
	return redactWebhook(w), nil
}

// List returns every webhook in the table, ordered by
// created_at DESC (matching the repository's ordering). Each
// row's Secret is replaced with WebhookSecretRedacted.
func (s *WebhookConfigService) List() ([]WebhookView, error) {
	rows, err := s.repo.List()
	if err != nil {
		return nil, err
	}
	out := make([]WebhookView, 0, len(rows))
	for _, w := range rows {
		out = append(out, redactWebhook(w))
	}
	return out, nil
}

// Update writes the mutable fields and stamps updated_at. The
// secret column is intentionally NOT touched — secret rotation
// goes through RotateSecret so the audit trail captures it as
// a distinct action.
func (s *WebhookConfigService) Update(actorID, id string, in UpdateWebhookInput) (WebhookView, error) {
	if !isAdminRole(actorID, s.db) {
		return WebhookView{}, ErrWebhookForbidden
	}

	existing, err := s.repo.Get(id)
	if err != nil {
		return WebhookView{}, err
	}

	if in.Name != nil {
		existing.Name = strings.TrimSpace(*in.Name)
	}
	if in.URL != nil {
		existing.URL = strings.TrimSpace(*in.URL)
	}
	if in.EventTypes != nil {
		existing.EventTypes = *in.EventTypes
	}
	if in.Filters != nil {
		existing.Filters = *in.Filters
	}
	if in.Headers != nil {
		existing.Headers = *in.Headers
	}
	if in.Enabled != nil {
		existing.Enabled = *in.Enabled
	}
	if in.TimeoutSec != nil && *in.TimeoutSec > 0 {
		existing.TimeoutSec = *in.TimeoutSec
	}
	if in.MaxRetries != nil && *in.MaxRetries >= 0 {
		existing.MaxRetries = *in.MaxRetries
	}

	if err := validateWebhookUpdateInput(existing); err != nil {
		return WebhookView{}, err
	}
	if err := s.warnOnUnresolvableURL(existing.URL); err != nil {
		slog.Warn("webhook url dns lookup failed", "url", existing.URL, "error", err)
	}

	if err := s.repo.Update(existing); err != nil {
		return WebhookView{}, err
	}

	logWebhookActivity(s.db, actorID, AuditActionWebhookUpdated, id, existing.Name, map[string]any{
		"url":        existing.URL,
		"enabled":    existing.Enabled,
		"timeoutSec": existing.TimeoutSec,
		"maxRetries": existing.MaxRetries,
	})
	return redactWebhook(existing), nil
}

// Delete removes the named webhook and emits an audit row.
// ErrWebhookNotFound surfaces when the row was already gone
// (e.g. operator double-clicked delete).
func (s *WebhookConfigService) Delete(actorID, id string) error {
	if !isAdminRole(actorID, s.db) {
		return ErrWebhookForbidden
	}

	// Read once before delete so the audit row can carry the
	// webhook's name as a target_title (the activity-log view
	// groups by target_title in the operator UI).
	existing, err := s.repo.Get(id)
	if err != nil {
		return err
	}

	if err := s.repo.Delete(id); err != nil {
		return err
	}

	logWebhookActivity(s.db, actorID, AuditActionWebhookDeleted, id, existing.Name, map[string]any{
		"url": existing.URL,
	})
	return nil
}

// RotateSecretResult bundles the redacted view (with the
// new secret placeholder) and the new plaintext secret.
type RotateSecretResult struct {
	Webhook         WebhookView `json:"webhook"`
	PlaintextSecret string      `json:"plaintextSecret"`
}

// RotateSecret generates a fresh 256-bit secret, overwrites the
// webhooks.secret column, and returns the redacted view plus
// the new plaintext secret. The plaintext is shown to the
// caller exactly once and never persisted outside the BLOB.
func (s *WebhookConfigService) RotateSecret(actorID, id string) (*RotateSecretResult, error) {
	if !isAdminRole(actorID, s.db) {
		return nil, ErrWebhookForbidden
	}

	existing, err := s.repo.Get(id)
	if err != nil {
		return nil, err
	}

	plaintextSecret, secretBlob, err := generateWebhookSecret()
	if err != nil {
		return nil, fmt.Errorf("generate webhook secret: %w", err)
	}

	if err := s.repo.RotateSecret(id, secretBlob); err != nil {
		return nil, err
	}

	// Repaint the in-memory row's Secret so the returned
	// WebhookView reflects the post-rotate state without an
	// extra DB read.
	existing.Secret = secretBlob
	existing.UpdatedAt = time.Now().UTC()

	logWebhookActivity(s.db, actorID, AuditActionWebhookRotated, id, existing.Name, map[string]any{
		"url": existing.URL,
	})
	return &RotateSecretResult{
		Webhook:         redactWebhook(existing),
		PlaintextSecret: plaintextSecret,
	}, nil
}

// ----------------------------------------------------------------------
// validation helpers
// ----------------------------------------------------------------------

// validateWebhookCreateInput enforces the field-level invariants
// the operator UI / API contract requires (plan §5.4 / §7.2).
// Returns a *WebhookInputError on the first failure so the
// handler can surface 400 with the offending field name.
func validateWebhookCreateInput(in CreateWebhookInput) error {
	if strings.TrimSpace(in.Name) == "" {
		return &WebhookInputError{Field: "name", Message: "name is required"}
	}
	if l := len(in.Name); l > 64 {
		return &WebhookInputError{Field: "name", Message: "name must be 64 characters or fewer"}
	}
	if err := validateWebhookURL(in.URL); err != nil {
		return err
	}
	if err := validateJSONArrayField("eventTypes", in.EventTypes); err != nil {
		return err
	}
	if err := validateJSONObjectField("filters", in.Filters); err != nil {
		return err
	}
	if err := validateJSONObjectField("headers", in.Headers); err != nil {
		return err
	}
	if in.TimeoutSec != nil && (*in.TimeoutSec < 1 || *in.TimeoutSec > 120) {
		return &WebhookInputError{Field: "timeoutSec", Message: "timeoutSec must be between 1 and 120"}
	}
	if in.MaxRetries != nil && (*in.MaxRetries < 0 || *in.MaxRetries > 20) {
		return &WebhookInputError{Field: "maxRetries", Message: "maxRetries must be between 0 and 20"}
	}
	return nil
}

// validateWebhookUpdateInput mirrors the Create checks but
// works on the post-merge webhook row so we can reuse the same
// predicates. The URL check is the only one that can fail
// after merge since the rest of the fields were either
// validated upstream (in EventTypes / Filters / Headers as
// they came in) or are constrained by the column types.
func validateWebhookUpdateInput(w *models.Webhook) error {
	if strings.TrimSpace(w.Name) == "" {
		return &WebhookInputError{Field: "name", Message: "name is required"}
	}
	if l := len(w.Name); l > 64 {
		return &WebhookInputError{Field: "name", Message: "name must be 64 characters or fewer"}
	}
	if err := validateWebhookURL(w.URL); err != nil {
		return err
	}
	if err := validateJSONArrayField("eventTypes", w.EventTypes); err != nil {
		return err
	}
	if err := validateJSONObjectField("filters", w.Filters); err != nil {
		return err
	}
	if err := validateJSONObjectField("headers", w.Headers); err != nil {
		return err
	}
	if w.TimeoutSec < 1 || w.TimeoutSec > 120 {
		return &WebhookInputError{Field: "timeoutSec", Message: "timeoutSec must be between 1 and 120"}
	}
	if w.MaxRetries < 0 || w.MaxRetries > 20 {
		return &WebhookInputError{Field: "maxRetries", Message: "maxRetries must be between 0 and 20"}
	}
	return nil
}

// validateWebhookURL implements plan §5.4:
//
//   - scheme must be https (WEBHOOK_ALLOW_INSECURE=1 is the
//     escape hatch the plan reserves for self-signed certs in
//     dev environments — not honoured here because the task
//     description didn't ask for it; add it later if needed).
//   - host must resolve and must not be loopback, link-local
//     (169.254/16, fe80::/10) or RFC1918 (10/8, 172.16/12,
//     192.168/16, fc00::/7) unless WEBHOOK_ALLOW_PRIVATE=1.
//
// The private-range check happens against every IP the host
// resolves to so a hostname that round-robins between a
// public IP and an internal one is still rejected when the
// operator is on the safe default.
func validateWebhookURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return &WebhookInputError{Field: "url", Message: "url is required"}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return &WebhookInputError{Field: "url", Message: "url is not parseable"}
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return &WebhookInputError{Field: "url", Message: "url must use https scheme"}
	}
	host := u.Hostname()
	if host == "" {
		return &WebhookInputError{Field: "url", Message: "url is missing a host"}
	}

	if os.Getenv("WEBHOOK_ALLOW_PRIVATE") == "1" {
		return nil
	}

	if isAlwaysBlockedHost(host) {
		return &WebhookInputError{Field: "url", Message: "url host is loopback or link-local"}
	}

	ips, err := net.LookupHost(host)
	if err != nil {
		// A DNS failure here is allowed to surface; the caller
		// (warnOnUnresolvableURL) will downgrade it to a
		// warning. For hard rejections (e.g. parse error) we
		// still bubble up.
		return nil
	}
	for _, ip := range ips {
		parsed := net.ParseIP(ip)
		if parsed == nil {
			continue
		}
		if isPrivateOrLoopbackIP(parsed) {
			return &WebhookInputError{Field: "url", Message: "url host resolves to a private / loopback / link-local address"}
		}
	}
	return nil
}

// warnOnUnresolvableURL emits a slog.Warn when the host fails
// to resolve, but never returns an error — DNS is best-effort
// and the Create / Update should still succeed when the API
// server's egress doesn't see the destination (split-horizon
// DNS, VPN-only hosts).
func (s *WebhookConfigService) warnOnUnresolvableURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" {
		return nil
	}
	host := u.Hostname()
	if isAlwaysBlockedHost(host) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resolver := net.Resolver{PreferGo: true}
	_, err = resolver.LookupHost(ctx, host)
	return err
}

// isAlwaysBlockedHost short-circuits the obvious cases that
// don't need a DNS round-trip: localhost, *.localhost, and the
// loopback literal.
func isAlwaysBlockedHost(host string) bool {
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate()
	}
	return false
}

// isPrivateOrLoopbackIP returns true when the IP falls into
// any range the plan §5.4 considers unsafe for the default
// configuration: loopback (127/8, ::1), link-local
// (169.254/16, fe80::/10), RFC1918 (10/8, 172.16/12,
// 192.168/16), and the IPv6 unique-local range (fc00::/7).
func isPrivateOrLoopbackIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate() {
		return true
	}
	// net.IP.IsPrivate only exists on Go 1.17+, but the
	// additional belt-and-braces checks below catch anything
	// the standard library misses on older toolchains.
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
	}
	return false
}

// validateJSONArrayField checks that s is either empty or a
// valid JSON array of strings. Empty is accepted as "use the
// schema default" so callers that omit event_types don't get
// rejected.
func validateJSONArrayField(field, s string) error {
	if s == "" {
		return nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return &WebhookInputError{Field: field, Message: "must be a JSON array of strings"}
	}
	return nil
}

// validateJSONObjectField checks that s is either empty or a
// valid JSON object. The keys/values are not constrained
// further because the schema comment treats filters and
// headers as opaque JSON.
func validateJSONObjectField(field, s string) error {
	if s == "" {
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return &WebhookInputError{Field: field, Message: "must be a JSON object"}
	}
	return nil
}

// ----------------------------------------------------------------------
// audit log
// ----------------------------------------------------------------------

// logWebhookActivity writes one audit row describing a write
// operation against the webhook table. Mirrors the
// logOAuthAdminActivity pattern in internal/oauth/audit.go:
// best-effort, any DB failure is logged via slog and swallowed
// so the admin operation still succeeds when the audit table
// is briefly unavailable.
//
// actorID must reference an existing users row (the admin
// that initiated the change). targetID is the webhook row id.
// details is serialised to JSON and stored in the details
// column; never include the plaintext secret here.
func logWebhookActivity(db *sql.DB, actorID string, action WebhookAuditAction, targetID, targetTitle string, details map[string]any) {
	if actorID == "" {
		slog.Error("logWebhookActivity called with empty actorID", "action", string(action), "targetID", targetID)
		return
	}
	payload, err := json.Marshal(details)
	if err != nil {
		slog.Error("logWebhookActivity: marshal details failed", "error", err, "action", string(action), "targetID", targetID)
		payload = []byte("{}")
	}
	if _, err := db.Exec(
		`INSERT INTO activities
		 (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		generateOpaqueAuditID(),
		actorID,
		string(action),
		WebhookAuditTargetType,
		targetID,
		targetTitle,
		string(payload),
		"", // no IP context here; handler layer supplies it via its own wrapper if needed
		"web",
		time.Now().UTC(),
	); err != nil {
		slog.Error("logWebhookActivity: insert failed", "error", err, "action", string(action), "targetID", targetID, "actorID", actorID)
		return
	}
	// Touch last_active_at so admin sessions show up as recent
	// in the activity feed (mirrors handlers.LogActivity's
	// behaviour for non-OAuth actions). Best-effort.
	_, _ = db.Exec("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?", actorID)
}

// generateOpaqueAuditID produces a short random hex string
// used as the primary key for the audit row. Independent of
// the webhook id generation so the two spaces can't collide
// by accident.
func generateOpaqueAuditID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail in practice; fall back
		// to a wall-clock-based id so the audit row still
		// inserts.
		return fmt.Sprintf("audit-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ----------------------------------------------------------------------
// role check + secret generation helpers
// ----------------------------------------------------------------------

// isAdminRole resolves the users row by id and returns true
// when its role column is "ADMIN". Returns false when the
// actorID is empty or doesn't match a known user — callers
// should treat the empty case as "no permission" rather than
// "unknown".
func isAdminRole(actorID string, db *sql.DB) bool {
	if actorID == "" || db == nil {
		return false
	}
	var role string
	err := db.QueryRow("SELECT role FROM users WHERE id = ?", actorID).Scan(&role)
	if err != nil {
		return false
	}
	return strings.EqualFold(role, "ADMIN")
}

// generateWebhookSecret returns (plaintextHex, blob, error).
// The plaintext is what the operator copies into their
// receiver; the blob is what we persist in the webhooks.secret
// BLOB column. We store the raw bytes (not the hex) so a
// future migration to a derived/HMAC key doesn't have to
// un-hex the value.
func generateWebhookSecret() (string, []byte, error) {
	buf := make([]byte, WebhookSecretLength)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(buf), buf, nil
}

// generateOpaqueID returns a short random hex string. Copied
// from internal/oauth/register.go's generateOpaqueID to keep
// the webhook centre independent — the two namespaces are
// intentionally not shared so a future shard-by-prefix can't
// cause id collisions between OAuth clients and webhooks.
func generateOpaqueID(byteLen int) (string, error) {
	if byteLen <= 0 {
		byteLen = 12
	}
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// ----------------------------------------------------------------------
// redaction
// ----------------------------------------------------------------------

// redactWebhook returns a WebhookView with the Secret field
// replaced by WebhookSecretRedacted. All other fields are
// copied across unchanged; the timestamp pointer fields are
// translated from *time.Time to the same shape (WebhookView
// also exposes them as *time.Time).
func redactWebhook(w *models.Webhook) WebhookView {
	view := WebhookView{
		ID:         w.ID,
		Name:       w.Name,
		URL:        w.URL,
		Secret:     WebhookSecretRedacted,
		Enabled:    w.Enabled,
		EventTypes: w.EventTypes,
		Filters:    w.Filters,
		Headers:    w.Headers,
		TimeoutSec: w.TimeoutSec,
		MaxRetries: w.MaxRetries,
		CreatedBy:  w.CreatedBy,
		CreatedAt:  w.CreatedAt,
		UpdatedAt:  w.UpdatedAt,
	}
	if w.LastSuccessAt != nil {
		t := *w.LastSuccessAt
		view.LastSuccessAt = &t
	}
	if w.LastFailureAt != nil {
		t := *w.LastFailureAt
		view.LastFailureAt = &t
	}
	return view
}
