package oauth

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"
)

// OAuthAdminAuditAction enumerates the action strings written to the
// activities table by the OAuth admin-operation handlers under
// backend/internal/oauth. Each value must be listed in the CHECK
// constraint added by migration 013_oauth_admin_audit_activity (s-1147,
// plan §6.4); a typo here surfaces as an INSERT error from the
// migration runner test, not a runtime 500.
type OAuthAdminAuditAction string

const (
	AuditActionOAuthProviderCreate  OAuthAdminAuditAction = "OAUTH_PROVIDER_CREATE"
	AuditActionOAuthProviderUpdate  OAuthAdminAuditAction = "OAUTH_PROVIDER_UPDATE"
	AuditActionOAuthProviderDelete  OAuthAdminAuditAction = "OAUTH_PROVIDER_DELETE"
	AuditActionOAuthProviderEnable  OAuthAdminAuditAction = "OAUTH_PROVIDER_ENABLE"
	AuditActionOAuthProviderDisable OAuthAdminAuditAction = "OAUTH_PROVIDER_DISABLE"
	AuditActionOAuthClientDelete    OAuthAdminAuditAction = "OAUTH_CLIENT_DELETE"
	AuditActionOAuthConfigUpdate    OAuthAdminAuditAction = "OAUTH_CONFIG_UPDATE"
	AuditActionOAuthConsentRevoke   OAuthAdminAuditAction = "OAUTH_CONSENT_REVOKE"
)

// AuditTargetType is the activities.target_type value stamped on
// every OAuth admin audit row. It is added to the activities
// target_type CHECK in the same migration as the action list
// above (migration 013).
const AuditTargetType = "OAUTH"

// OAuthAuditDetails is the structured `details` payload stored in
// the activities row. The shape is intentionally minimal and
// serialised as JSON: enough context for an admin audit trail
// (which field changed, what the previous value was) without
// leaking credentials. Never write client_secret plaintext or
// the encrypted BLOB — only the boolean `secretSet` flag.
type OAuthAuditDetails struct {
	// Field changes. `Changed` lists the field names that the
	// caller touched in this request; `Previous` carries the
	// old value for fields the audit trail needs to roll back.
	Changed  []string          `json:"changed,omitempty"`
	Previous map[string]string `json:"previous,omitempty"`
	// SecretChanged is true when client_secret was set or
	// rotated. The plaintext is never persisted.
	SecretChanged bool `json:"secretChanged,omitempty"`
	// ConfigKeys lists the app_config keys touched on
	// OAUTH_CONFIG_UPDATE. Length 0 for other actions.
	ConfigKeys []string `json:"configKeys,omitempty"`
	// Existed reflects the prior state for DELETE / REVOKE so
	// the audit row can answer "was the row actually present
	// before the admin hit delete".
	Existed bool `json:"existed,omitempty"`
	// EnabledBefore / EnabledAfter describe the boolean
	// transition when the action is OAUTH_PROVIDER_ENABLE or
	// OAUTH_PROVIDER_DISABLE; otherwise both are nil.
	EnabledBefore *bool `json:"enabledBefore,omitempty"`
	EnabledAfter  *bool `json:"enabledAfter,omitempty"`
}

// logOAuthAdminActivity writes one audit row describing an
// admin-initiated change to OAuth configuration (plan §6.4,
// s-1147). The row is written directly via SQL — going through
// handlers.LogActivity would invert the dependency (handlers
// already imports oauth). Best-effort: any DB failure is logged
// via slog and swallowed so the admin operation still succeeds
// even when the audit table is briefly unavailable.
//
// actorID must reference an existing users row (the admin that
// initiated the change). targetID is the resource the action
// touched — the provider row id, the OAuth client id, the
// config key (for OAUTH_CONFIG_UPDATE), or the consent
// (user_id, client_id) tuple for OAUTH_CONSENT_REVOKE. ipAddress
// is c.ClientIP() so the same audit trail applies to web and
// CLI callers.
func logOAuthAdminActivity(
	db *sql.DB,
	actorID string,
	action OAuthAdminAuditAction,
	targetID string,
	targetTitle string,
	details OAuthAuditDetails,
	ipAddress string,
) {
	if actorID == "" {
		slog.Error("logOAuthAdminActivity called with empty actorID",
			"action", string(action),
			"target_id", targetID,
		)
		return
	}
	payload, err := json.Marshal(details)
	if err != nil {
		// Marshalling a fixed-shape struct should never fail,
		// but if it ever does (e.g. a future field with an
		// unsupported type) log loudly and fall back to an
		// empty payload so the audit row still records the
		// action.
		slog.Error("logOAuthAdminActivity: marshal details failed",
			"error", err,
			"action", string(action),
			"target_id", targetID,
		)
		payload = []byte("{}")
	}
	if _, err := db.Exec(
		`INSERT INTO activities
		 (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		generateOpaqueID(),
		actorID,
		string(action),
		AuditTargetType,
		targetID,
		targetTitle,
		string(payload),
		ipAddress,
		"web",
		time.Now(),
	); err != nil {
		slog.Error("logOAuthAdminActivity: insert failed",
			"error", err,
			"action", string(action),
			"target_id", targetID,
			"actor_id", actorID,
		)
		return
	}
	// Touch last_active_at so admin sessions show up as recent
	// in the activity feed (mirrors handlers.LogActivity's
	// behaviour for non-OAuth actions). Best-effort — failure
	// here is non-fatal because the audit row is already
	// persisted above.
	_, _ = db.Exec("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?", actorID)
}
