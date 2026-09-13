package oauth_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/oauth"
)

// activityRow mirrors the columns the OAuth admin audit logger
// writes (s-1147). Kept local to the test file because the
// audit logger is intentionally not exported — the test relies
// on direct SQL inspection rather than reaching into the
// handler internals.
type activityRow struct {
	ID          string
	UserID      string
	Action      string
	TargetType  string
	TargetID    sql.NullString
	TargetTitle sql.NullString
	Details     sql.NullString
	IPAddress   sql.NullString
	Source      string
	CreatedAt   time.Time
}

// fetchAuditRows pulls every activities row the test scenario
// produced, ordered by created_at so the test can assert
// event ordering on multi-row actions (e.g. enable + update
// from a single PUT).
func fetchAuditRows(t *testing.T, db *sql.DB) []activityRow {
	t.Helper()
	rows, err := db.Query(
		`SELECT id, user_id, action, target_type, target_id, target_title,
		        details, ip_address, source, created_at
		 FROM activities ORDER BY created_at ASC, id ASC`,
	)
	if err != nil {
		t.Fatalf("query activities: %v", err)
	}
	defer rows.Close()
	var out []activityRow
	for rows.Next() {
		var r activityRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.Action, &r.TargetType,
			&r.TargetID, &r.TargetTitle, &r.Details, &r.IPAddress,
			&r.Source, &r.CreatedAt); err != nil {
			t.Fatalf("scan activity: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// auditRowFor returns the first activities row whose action
// matches; nil when none. The handler may emit more than one
// row per request (e.g. enable + update), so callers that need
// to assert ordering must look at the slice directly.
func auditRowFor(rows []activityRow, action string) *activityRow {
	for i := range rows {
		if rows[i].Action == action {
			return &rows[i]
		}
	}
	return nil
}

// 1. CreateAdminProviderHandler writes exactly one
//    OAUTH_PROVIDER_CREATE row with target_id=provider id,
//    target_title=provider_id (the slug), target_type='OAUTH',
//    source='web', and a details payload listing the changed
//    fields. The plaintext client_secret never appears in the
//    audit row.
func TestOAuthAudit_CreateProvider(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	body := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "google-client-id",
		"clientSecret": "shhh-very-secret",
		"scopes": "openid email profile"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.42")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 activity row, got %d: %+v", len(rows), rows)
	}
	r0 := rows[0]
	if r0.Action != "OAUTH_PROVIDER_CREATE" {
		t.Errorf("action mismatch: got %q want OAUTH_PROVIDER_CREATE", r0.Action)
	}
	if r0.TargetType != "OAUTH" {
		t.Errorf("target_type mismatch: got %q want OAUTH", r0.TargetType)
	}
	if r0.UserID != "test-caller" {
		t.Errorf("user_id mismatch: got %q want test-caller", r0.UserID)
	}
	if !r0.TargetID.Valid || r0.TargetID.String != resp["id"] {
		t.Errorf("target_id mismatch: got %v want %v", r0.TargetID, resp["id"])
	}
	if !r0.TargetTitle.Valid || r0.TargetTitle.String != "google" {
		t.Errorf("target_title mismatch: got %v want google", r0.TargetTitle)
	}
	if r0.Source != "web" {
		t.Errorf("source mismatch: got %q want web", r0.Source)
	}
	// IP is taken from c.ClientIP(); behind a trusted proxy
	// gin honours X-Forwarded-For. Our router in this test
	// runs gin.Default() via New() which doesn't enable
	// (*Engine).TrustedProxies, so X-Forwarded-For is ignored
	// and c.ClientIP() returns the loopback. We accept either
	// the explicit header value or the loopback to stay
	// portable across gin versions.
	if r0.IPAddress.String != "203.0.113.42" && r0.IPAddress.String != "127.0.0.1" && r0.IPAddress.String != "::1" {
		t.Errorf("ip_address mismatch: got %q", r0.IPAddress.String)
	}
	if !r0.Details.Valid {
		t.Fatalf("details column must be populated, got NULL")
	}
	var details map[string]interface{}
	if err := json.Unmarshal([]byte(r0.Details.String), &details); err != nil {
		t.Fatalf("details must be valid JSON: %v", err)
	}
	changed, ok := details["changed"].([]interface{})
	if !ok {
		t.Fatalf("details.changed must be an array, got %T", details["changed"])
	}
	if len(changed) == 0 {
		t.Errorf("details.changed must list at least one field")
	}
	// The plaintext client_secret must never leak into the
	// audit row, even as a "previous" value. The SecretChanged
	// boolean is the only signal that a credential was set.
	if strings.Contains(r0.Details.String, "shhh-very-secret") {
		t.Errorf("plaintext client_secret leaked into details: %s", r0.Details.String)
	}
	if secretChanged, _ := details["secretChanged"].(bool); !secretChanged {
		t.Errorf("details.secretChanged should be true when clientSecret was provided")
	}
}

// 2. UpdateAdminProviderHandler writes OAUTH_PROVIDER_UPDATE
//    when fields other than enabled change. The previous values
//    land in details.previous so a forensic reviewer can roll
//    back without consulting the row's prior state.
func TestOAuthAudit_UpdateProviderWritesAuditRow(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	createBody := `{
		"providerId": "google",
		"name": "Original Name",
		"type": "google",
		"enabled": true,
		"clientId": "cid",
		"clientSecret": "shhh"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("seed create: expected 201 got %d %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())

	// Reset the activity table so we can isolate the update
	// row from the seed create row.
	if _, err := db.Exec(`DELETE FROM activities`); err != nil {
		t.Fatalf("clear activities: %v", err)
	}

	updateBody := `{
		"name": "Renamed",
		"clientId": "new-cid"
	}`
	uReq := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/"+resp["id"].(string), strings.NewReader(updateBody))
	uReq.Header.Set("Content-Type", "application/json")
	uW := httptest.NewRecorder()
	r.ServeHTTP(uW, uReq)
	if uW.Code != http.StatusOK {
		t.Fatalf("update: expected 200 got %d %s", uW.Code, uW.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 activity row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_PROVIDER_UPDATE" {
		t.Errorf("action mismatch: got %q want OAUTH_PROVIDER_UPDATE", rows[0].Action)
	}
	if !rows[0].TargetID.Valid || rows[0].TargetID.String != resp["id"].(string) {
		t.Errorf("target_id mismatch: %v", rows[0].TargetID)
	}
	var details map[string]interface{}
	if err := json.Unmarshal([]byte(rows[0].Details.String), &details); err != nil {
		t.Fatalf("details JSON: %v", err)
	}
	changed, _ := details["changed"].([]interface{})
	gotChanged := map[string]bool{}
	for _, c := range changed {
		gotChanged[c.(string)] = true
	}
	if !gotChanged["name"] || !gotChanged["client_id"] {
		t.Errorf("details.changed must list name+client_id, got %v", gotChanged)
	}
	previous, _ := details["previous"].(map[string]interface{})
	if previous["name"] != "Original Name" {
		t.Errorf("details.previous.name mismatch: got %v want 'Original Name'", previous["name"])
	}
	if previous["client_id"] != "cid" {
		t.Errorf("details.previous.client_id mismatch: got %v want cid", previous["client_id"])
	}
}

// 3. UpdateAdminProviderHandler writes OAUTH_PROVIDER_ENABLE /
//    OAUTH_PROVIDER_DISABLE when only the boolean enabled flag
//    flips, with enabledBefore / enabledAfter populated so the
//    activity-log view can render the transition.
func TestOAuthAudit_UpdateProviderEnableDisable(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	createBody := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "cid",
		"clientSecret": "shhh"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("seed create: %d %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if _, err := db.Exec(`DELETE FROM activities`); err != nil {
		t.Fatalf("clear activities: %v", err)
	}

	// Disable.
	disable := `{"enabled": false}`
	uReq := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/"+resp["id"].(string), strings.NewReader(disable))
	uReq.Header.Set("Content-Type", "application/json")
	uW := httptest.NewRecorder()
	r.ServeHTTP(uW, uReq)
	if uW.Code != http.StatusOK {
		t.Fatalf("disable: %d %s", uW.Code, uW.Body.String())
	}
	// Re-enable.
	enable := `{"enabled": true}`
	eReq := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/"+resp["id"].(string), strings.NewReader(enable))
	eReq.Header.Set("Content-Type", "application/json")
	eW := httptest.NewRecorder()
	r.ServeHTTP(eW, eReq)
	if eW.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", eW.Code, eW.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 2 {
		t.Fatalf("expected 2 activity rows, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_PROVIDER_DISABLE" {
		t.Errorf("first row action mismatch: got %q want OAUTH_PROVIDER_DISABLE", rows[0].Action)
	}
	if rows[1].Action != "OAUTH_PROVIDER_ENABLE" {
		t.Errorf("second row action mismatch: got %q want OAUTH_PROVIDER_ENABLE", rows[1].Action)
	}
	for _, r := range rows {
		var details map[string]interface{}
		if err := json.Unmarshal([]byte(r.Details.String), &details); err != nil {
			t.Fatalf("details JSON: %v", err)
		}
		if _, ok := details["enabledBefore"]; !ok {
			t.Errorf("details.enabledBefore must be set on enable/disable rows")
		}
		if _, ok := details["enabledAfter"]; !ok {
			t.Errorf("details.enabledAfter must be set on enable/disable rows")
		}
	}
}

// 4. When an update changes BOTH enabled and other fields, the
//    handler emits two rows in order: OAUTH_PROVIDER_ENABLE /
//    DISABLE first (because the boolean flip is the more
//    security-relevant event), then OAUTH_PROVIDER_UPDATE for
//    the rest. The test pins that ordering.
func TestOAuthAudit_UpdateProviderEnablePlusOther(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	createBody := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "cid",
		"clientSecret": "shhh"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("seed create: %d %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if _, err := db.Exec(`DELETE FROM activities`); err != nil {
		t.Fatalf("clear activities: %v", err)
	}

	combined := `{"enabled": false, "name": "Renamed"}`
	uReq := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/"+resp["id"].(string), strings.NewReader(combined))
	uReq.Header.Set("Content-Type", "application/json")
	uW := httptest.NewRecorder()
	r.ServeHTTP(uW, uReq)
	if uW.Code != http.StatusOK {
		t.Fatalf("update: %d %s", uW.Code, uW.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_PROVIDER_DISABLE" {
		t.Errorf("first row action mismatch: got %q want OAUTH_PROVIDER_DISABLE", rows[0].Action)
	}
	if rows[1].Action != "OAUTH_PROVIDER_UPDATE" {
		t.Errorf("second row action mismatch: got %q want OAUTH_PROVIDER_UPDATE", rows[1].Action)
	}
}

// 5. DeleteAdminProviderHandler writes OAUTH_PROVIDER_DELETE
//    with target_title=provider_id (the slug) so the audit log
//    can answer "what was deleted" without joining back to the
//    (now gone) provider row.
func TestOAuthAudit_DeleteProvider(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	createBody := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "cid",
		"clientSecret": "shhh"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("seed create: %d %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if _, err := db.Exec(`DELETE FROM activities`); err != nil {
		t.Fatalf("clear activities: %v", err)
	}

	dReq := httptest.NewRequest(http.MethodDelete, "/api/v1/oauth/providers/"+resp["id"].(string), nil)
	dW := httptest.NewRecorder()
	r.ServeHTTP(dW, dReq)
	if dW.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", dW.Code, dW.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_PROVIDER_DELETE" {
		t.Errorf("action mismatch: got %q", rows[0].Action)
	}
	if !rows[0].TargetID.Valid || rows[0].TargetID.String != resp["id"].(string) {
		t.Errorf("target_id mismatch: got %v want %v", rows[0].TargetID, resp["id"])
	}
	if !rows[0].TargetTitle.Valid || rows[0].TargetTitle.String != "google" {
		t.Errorf("target_title mismatch: got %v want google", rows[0].TargetTitle)
	}
}

// 6. DeleteAdminClientHandler writes OAUTH_CLIENT_DELETE with
//    target_id=client_id (the OAuth client's externally visible
//    identifier, not its internal row id).
func TestOAuthAudit_DeleteClient(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	insertClient(t, db, "kanban-client-1", "", "open-kanban-mcp",
		[]string{"urn:ietf:params:oauth:grant-type:device_code"}, []string{"kanban:read"})
	r := newAdminServer(t, db)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/clients?client_id=kanban-client-1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_CLIENT_DELETE" {
		t.Errorf("action mismatch: got %q want OAUTH_CLIENT_DELETE", rows[0].Action)
	}
	if !rows[0].TargetID.Valid || rows[0].TargetID.String != "kanban-client-1" {
		t.Errorf("target_id mismatch: got %v want kanban-client-1", rows[0].TargetID)
	}
	if rows[0].UserID != "user-1" {
		t.Errorf("user_id mismatch: got %q want user-1", rows[0].UserID)
	}
}

// 7. UpdateOAuthConfigHandler writes OAUTH_CONFIG_UPDATE with
//    details.configKeys listing every app_config key the admin
//    touched in this request, and details.previous carrying the
//    pre-update value of each key.
func TestOAuthAudit_UpdateConfig(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	if err := oauth.EnsureDefaults(db); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}
	r := newAdminServer(t, db)

	body := `{"updates":{"oauth_access_token_ttl_seconds":"1800","oauth_device_poll_interval_seconds":"10"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/oauth/config", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_CONFIG_UPDATE" {
		t.Errorf("action mismatch: got %q", rows[0].Action)
	}
	var details map[string]interface{}
	if err := json.Unmarshal([]byte(rows[0].Details.String), &details); err != nil {
		t.Fatalf("details JSON: %v", err)
	}
	keys, _ := details["configKeys"].([]interface{})
	gotKeys := map[string]bool{}
	for _, k := range keys {
		gotKeys[k.(string)] = true
	}
	if !gotKeys["oauth_access_token_ttl_seconds"] || !gotKeys["oauth_device_poll_interval_seconds"] {
		t.Errorf("details.configKeys must list both touched keys, got %v", gotKeys)
	}
	previous, _ := details["previous"].(map[string]interface{})
	if previous["oauth_access_token_ttl_seconds"] != "3600" {
		t.Errorf("details.previous.oauth_access_token_ttl_seconds mismatch: got %v want 3600", previous["oauth_access_token_ttl_seconds"])
	}
}

// 8. RevokeConsentHandler writes OAUTH_CONSENT_REVOKE with
//    target_id=client_id and details.existed=true when the
//    consent row was actually present before the call.
func TestOAuthAudit_RevokeConsent(t *testing.T) {
	db := setupAdminDB(t)
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO oauth_consents (id, user_id, client_id, scope, granted_at) VALUES ('c1', 'user-1', 'kanban-client-1', 'kanban:read', ?)`,
		time.Now(),
	); err != nil {
		t.Fatalf("seed consent: %v", err)
	}
	// Build a router with the user injected (the production
	// mount sits behind RequireAuth).
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("user", AdminUserFixture)
		c.Next()
	})
	r.DELETE("/api/v1/auth/oauth/consents", oauth.RevokeConsentHandler(db))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/oauth/consents?client_id=kanban-client-1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}

	rows := fetchAuditRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "OAUTH_CONSENT_REVOKE" {
		t.Errorf("action mismatch: got %q", rows[0].Action)
	}
	if !rows[0].TargetID.Valid || rows[0].TargetID.String != "kanban-client-1" {
		t.Errorf("target_id mismatch: got %v want kanban-client-1", rows[0].TargetID)
	}
	var details map[string]interface{}
	if err := json.Unmarshal([]byte(rows[0].Details.String), &details); err != nil {
		t.Fatalf("details JSON: %v", err)
	}
	if existed, _ := details["existed"].(bool); !existed {
		t.Errorf("details.existed should be true when the consent row was present")
	}
}

// 9. A failed create (validation error) must NOT leave an audit
//    row — the activity log only records operations that
//    actually mutated state. Pins the "best-effort, no
//    speculative rows" contract.
func TestOAuthAudit_FailedCreateDoesNotLog(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	// Missing required clientId — handler should reject with 400.
	badBody := `{
		"providerId": "google",
		"name": "Google",
		"type": "google"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(badBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	rows := fetchAuditRows(t, db)
	if len(rows) != 0 {
		t.Errorf("expected 0 audit rows after failed create, got %d: %+v", len(rows), rows)
	}
}

// 10. Update with no changes (empty body) must NOT write an
//     audit row. The handler bails out before the audit logger
//     is reached, so the activities table stays untouched.
func TestOAuthAudit_NoOpUpdateDoesNotLog(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	createBody := `{
		"providerId": "google",
		"name": "Google",
		"type": "google",
		"enabled": true,
		"clientId": "cid",
		"clientSecret": "shhh"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/providers", strings.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("seed create: %d %s", w.Code, w.Body.String())
	}
	resp := decodeProvider(t, w.Body.Bytes())
	if _, err := db.Exec(`DELETE FROM activities`); err != nil {
		t.Fatalf("clear activities: %v", err)
	}

	// Empty body → no fields set → no changes.
	empty := `{}`
	uReq := httptest.NewRequest(http.MethodPut, "/api/v1/oauth/providers/"+resp["id"].(string), strings.NewReader(empty))
	uReq.Header.Set("Content-Type", "application/json")
	uW := httptest.NewRecorder()
	r.ServeHTTP(uW, uReq)
	if uW.Code != http.StatusOK {
		t.Fatalf("update: %d %s", uW.Code, uW.Body.String())
	}
	rows := fetchAuditRows(t, db)
	if len(rows) != 0 {
		t.Errorf("expected 0 audit rows for no-op update, got %d: %+v", len(rows), rows)
	}
}

// 11. Sanity: an attempted delete of a non-existent provider
//     returns 404 and writes no audit row. Pins the contract
//     that 404 is silent in the activity log (otherwise a
//     scanner would fill the table with 404 noise).
func TestOAuthAudit_DeleteMissingProviderDoesNotLog(t *testing.T) {
	withProviderSecretKey(t, validTestKey())
	db := setupProviderDB(t)
	defer db.Close()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO users (id, username, nickname, type, role, enabled)
		VALUES ('test-caller', 'test-caller', 'Test', 'HUMAN', 'ADMIN', 1)
	`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	r := newProviderServerAsAdmin(t, db, "ADMIN")

	dReq := httptest.NewRequest(http.MethodDelete, "/api/v1/oauth/providers/does-not-exist", nil)
	dW := httptest.NewRecorder()
	r.ServeHTTP(dW, dReq)
	if dW.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", dW.Code, dW.Body.String())
	}
	rows := fetchAuditRows(t, db)
	if len(rows) != 0 {
		t.Errorf("expected 0 audit rows after 404 delete, got %d: %+v", len(rows), rows)
	}
}
