package migrations

type VersionMigration struct {
	Version string
	From    int
	To      int
}

// VersionMigrationMap maps each released git tag to the migration
// numbers it covers. With the schema consolidated into a single
// initial migration, every current release sits at migration 1.
// Future releases that add schema changes should bump `To` to the
// new migration number; never edit history in place — add a new
// migration file under mysql/ and sqlite/ and bump the map.
var VersionMigrationMap = []VersionMigration{
	{Version: "0.1.0", From: 1, To: 1},
	{Version: "0.1.1", From: 1, To: 1},
	// 0.2.0 added migration 002 to extend the activities.action CHECK
	// constraint with PERMISSION_GRANT / PERMISSION_REVOKE so the
	// Set*/Delete* permission handlers can log their activity rows.
	{Version: "0.2.0", From: 1, To: 2},
	// 0.3.0 added migration 003 to backfill board_permissions.
	// owner_agent_id on legacy boards so the owner-aware permission
	// checks (IsBoardOwner / loadBoardAccess owner short-circuit) and
	// the new "owner can manage permissions" branch in
	// SetPermission / DeletePermission have a real owner to act on.
	{Version: "0.3.0", From: 1, To: 3},
	// 0.4.0 added migration 004 to introduce the task_runs table
	// (CLI runner claim/heartbeat lock — see
	// devDoc/CLI_RUNNER_PLAN_2026-09-12.md §3.3). The plan's §7 lists
	// the upstream CLI work as a sibling change in the same release;
	// only the schema lands in this tag, the API/handler layer ships
	// under a follow-up.
	{Version: "0.4.0", From: 1, To: 4},
	// 0.5.0 keeps the schema aligned with the latest migration files
	// without bumping the migration counter itself; this matters for
	// dev databases cloned at the 0.4.0 tag and for the e2e helper
	// binary which runs migrations against an empty in-memory SQLite
	// and would otherwise miss migration 004.
	{Version: "0.5.0", From: 1, To: 4},
	// 0.6.0 added migration 006 to add the history indexes on
	// task_runs (s-1106). The application-side behaviour change
	// (FinishRun stops DELETing terminal rows, /runs/history
	// endpoint ships under s-1107) lands in the same release but
	// doesn't touch this map because it doesn't add a new
	// migration file. Operators upgrading from 0.5.x get the new
	// indexes on `up`; nothing changes for fresh installs.
	{Version: "0.6.0", From: 1, To: 6},
	// 0.7.0 added migration 007 to widen the activities.action /
	// activities.target_type CHECK constraints with DEVICE_APPROVE
	// and DEVICE (s-1118, plan §4.1.1 + §4.4) so the
	// /oauth/device/approve handler can write audit rows when a
	// human approver delegates a device code to an Agent identity.
	{Version: "0.7.0", From: 1, To: 7},
	// 0.8.0 added migration 008 to add users.created_by (s-1131)
	// so the API / CLI can answer "who created this Agent".
	// Pre-existing AGENT rows have NULL; only newly-inserted Agents
	// created via POST /api/v1/auth/agents (CLI `kanban auth agent
	// create`) are guaranteed to carry a value.
	{Version: "0.8.0", From: 1, To: 8},
	// 0.9.0 added migration 009 to introduce the oauth_providers
	// table (s-1140, plan §3.2 in
	// docs/OAUTH_EXTERNAL_PLAN_s-1139.md). The admin CRUD surface
	// and the encryption helper ship in sibling sub-tasks (s-1141
	// / s-1142); this tag is schema-only so dev builds that pull
	// a fresh DB pick up the table at startup without dragging in
	// the yet-to-be-merged handler layer.
	{Version: "0.9.0", From: 1, To: 9},
	// 0.10.0 added migration 010 to land the user_identities
	// binding table and the users.email lookup column (s-1142,
	// plan §3.3 / §5). The OAuth callback handler and the
	// user-mapping algorithm ship in the same release — the
	// schema is meaningless on its own without the handler that
	// writes to it, so unlike 0.9.0 we ship both together.
	{Version: "0.10.0", From: 1, To: 10},
	// 0.11.0 added migration 011 to introduce the
	// pending_oauth_states table (s-1145, plan §7.1 / §7.2).
	// The CSRF state + PKCE verifier minted by
	// /oauth/external/:slug/login live here for the 10-minute
	// TTL between the click and the IdP callback; without this
	// table the state parameter would be a signed cookie alone
	// (vulnerable to cookie-drop attacks on a shared host) and
	// PKCE would have nowhere to stash the verifier. The login
	// redirect handler ships in the same release as the schema.
	{Version: "0.11.0", From: 1, To: 11},
	// 0.12.0 added migration 012 to introduce the webhooks +
	// webhook_deliveries tables (s-1139, plan §4 in
	// docs/EVENT_CENTER_PLAN_s-1138.md). Originally drafted
	// as migration 009 in the plan, but the OAuth external-IdP
	// work (s-1140 / s-1142 / s-1145) shipped first and
	// claimed 009 / 010 / 011; this migration therefore lands
	// as 012 to keep the golang-migrate alphabetical sequence
	// monotonic. The CRUD / event-bus / signing / handler
	// sub-tasks (s-1140 / s-1141 / s-1142 / s-1143) ship in
	// follow-up releases against the same schema.
	{Version: "0.12.0", From: 1, To: 12},
	// 0.13.0 added migration 013 to extend the activities.action
	// CHECK constraint with the OAuth admin-operation actions
	// (OAUTH_PROVIDER_CREATE / UPDATE / DELETE / ENABLE / DISABLE,
	// OAUTH_CLIENT_DELETE, OAUTH_CONFIG_UPDATE, OAUTH_CONSENT_REVOKE)
	// and widen activities.target_type to include OAUTH (s-1147,
	// plan §6.4). The CRUD / encryption / callback sub-tasks
	// (s-1140 / s-1141 / s-1142 / s-1143) ship earlier against
	// the narrower CHECK; this migration closes the audit-log gap
	// so every admin write to oauth_providers / oauth_clients /
	// app_config / oauth_consents lands a row in the existing
	// activities table rather than silently disappearing.
	{Version: "0.13.0", From: 1, To: 13},
	// 0.14.0 added migration 014 to extend the activities.action
	// CHECK constraint with the webhook-centre admin-operation
	// actions in the dotted "<surface>.<verb>" notation the
	// plan document uses (webhook.created / updated / deleted /
	// rotated / tested, plan §6.2 in
	// docs/EVENT_CENTER_PLAN_s-1138.md), and widen
	// activities.target_type to include WEBHOOK (s-1140). The
	// Webhook config service / Webhook handler / dispatcher
	// sub-tasks (s-1141 / s-1142 / s-1143) ship in the same
	// release against the wider CHECK; this migration closes
	// the audit-log gap so every admin write to webhooks lands
	// a row in the existing activities table rather than
	// silently disappearing at the SQL CHECK constraint.
	{Version: "0.14.0", From: 1, To: 14},
	// 0.15.0 added migration 015 to add task_runs.output (s-1185)
	// so the CLI runner can persist the agent's stdout payload
	// (truncated to 64 KiB) separately from the existing
	// `error` column. Pre-s-1185 the runner wrote stderr into
	// the `error` field, which the UI labels as the
	// "错误信息" / "Error" string on the task detail page —
	// opencode's banner on stderr made every successful run
	// look like a failure. The CLI / handler / UI changes ship
	// in the same release so the new column is never read with
	// the old meaning.
	{Version: "0.15.0", From: 1, To: 15},
	// 0.16.0 added migration 016 to introduce boards.is_public so the
	// board list endpoint can hide private boards from anonymous and
	// unauthorized users. Defaults to 1 so existing boards stay
	// publicly visible after upgrade.
	{Version: "0.16.0", From: 1, To: 16},
	// 0.17.0 added migration 017 to extend the activities.action CHECK
	// constraint with PERMISSION_TRANSFER so the new TransferOwnership
	// handler (POST /api/v1/auth/permissions/transfer-ownership) can
	// record its activity row when a board owner hands ownership to
	// another user. See docs/PERMISSION_MATRIX.md section 4.8.
	{Version: "0.17.0", From: 1, To: 17},
	// 0.18.0 added migration 018 to extend the activities.action CHECK
	// constraint with PERMISSION_BULK_GRANT so the new
	// BulkSetPermissions handler (POST /api/v1/auth/permissions/bulk)
	// can record a single activity row per batch grant.
	{Version: "0.18.0", From: 1, To: 18},
	// 0.19.0 added migration 019 to widen comments.content from TEXT
	// (max 65,535 bytes on MySQL) to LONGTEXT (max 4 GiB) so the
	// CreateComment handler can accept arbitrarily long comment bodies
	// without the storage layer truncating or rejecting the INSERT.
	// SQLite side is documentation-only because SQLite TEXT is already
	// variable-length. Tracked as s-1018.
	{Version: "0.19.0", From: 1, To: 19},
	// 0.20.0 added migration 020 to add audit / lifecycle columns to
	// board_permissions and column_permissions:
	//   - granted_by_user_id  (FK users.id NULLABLE)
	//   - expires_at          (DATETIME NULLABLE)
	//   - revoked_at          (DATETIME NULLABLE)
	//   - revoked_by_user_id  (FK users.id NULLABLE)
	//   - notes (TEXT DEFAULT '', board_permissions only)
	// Existing rows are backfilled with NULL / '' defaults so the
	// migration is non-destructive. The SetPermission /
	// DeletePermission / SetColumnPermission / DeleteColumnPermission
	// handlers now stamp granted_by_user_id / revoked_by_user_id on
	// write, and DELETE was replaced with a soft-delete UPDATE so the
	// audit trail survives revoke. Tracked as s-1037.
	{Version: "0.20.0", From: 1, To: 20},
	// 0.21.0 added migration 021 to introduce the notifications table
	// that powers the in-app notification center (PM_REVIEW §5.2 ROI
	// #2). Rows are fan-out inserts by the handlers in
	// internal/handlers/notifications.go and surface as a bell-badge
	// stream driven by the existing WebSocket connection. Tracked
	// as s-1194.
	{Version: "0.21.0", From: 1, To: 21},
	// 0.22.0 added migration 022 to introduce the preset_templates
	// table that backs the first-login wizard and the public template
	// marketplace (PM_REVIEW §5.4 ROI #4 / §6). The table is seeded
	// with at least 4 starter presets (product iteration, bug triage,
	// content calendar, customer support) by the migration itself, so a
	// fresh install lands on a populated marketplace without any manual
	// configuration. Tracked as s-1196.
	{Version: "0.22.0", From: 1, To: 22},
	// 0.23.0 added migration 023 to give column_agents a
	// transition_trigger flag (none / on_enter / on_exit / both) so
	// the SetColumnAgent handler can wake a bound Agent automatically
	// when a task crosses the column boundary. Tracked as s-1214
	// (PM_REVIEW §3.5).
	{Version: "0.23.0", From: 1, To: 23},
	// 0.24.0 added migration 024 to introduce the
	// user_notification_preferences table that backs the new
	// "Notifications" section in Settings (PM_REVIEW §3.7). One row
	// per user with email_enabled / webhook_enabled flags plus a
	// webhook_url, so each delivery channel can be muted
	// independently. Tracked as s-1203.
	{Version: "0.24.0", From: 1, To: 24},
	// 0.25.0 added migration 025 to introduce the viewer_tokens
	// table that backs the public read-only share link + iframe
	// embed surface for boards (PM_REVIEW §6). One row per minted
	// token; the secret value is stored as a SHA-256 hash and the
	// plaintext is only returned ONCE at mint time, the same way
	// the regular /api/v1/auth/token endpoint behaves. Tracked as
	// s-1204.
	{Version: "0.25.0", From: 1, To: 25},
	// 0.26.0 added migration 026 to introduce the tasks.due_at
	// column so a freshly created task can carry a due date
	// straight through the create-task modal into the storage
	// layer (PM_REVIEW §3.12). The column is nullable; existing
	// rows are backfilled with NULL. The idx_tasks_due_at index
	// is built in the same migration so the upcoming "overdue /
	// due in next N days" surface can be served by a plain index
	// scan. Tracked as T-1207 / s-1207.
	{Version: "0.26.0", From: 1, To: 26},
	// 0.27.0 added migration 027 to extend the activities.action
	// CHECK constraint with BULK_ARCHIVE_COLUMN /
	// BULK_COMPLETE_COLUMN so the new BulkColumnAction handler
	// (POST /api/v1/tasks/bulk/column-action) can record a single
	// audit-log row per column-level "Archive all" / "Mark all as
	// completed" action surfaced by the new column-header
	// 3-dot menu. Tracked as s-1212.
	{Version: "0.27.0", From: 1, To: 27},
	// 0.28.0 added migration 028 to introduce the frontend_events
	// table that backs the new Sentry-compatible error sink at
	// /api/v1/frontend-events (PM_REVIEW_2026-09-17 §7). One row per
	// unhandled React error / window.onerror / unhandledrejection
	// captured by the root ErrorBoundary + global handlers. The
	// handler runs the same secret-redaction pass on the client
	// payload that the client runs itself, so a future client
	// regression cannot leak a credential into the database.
	// Tracked as s-1210.
	{Version: "0.28.0", From: 1, To: 28},
}

func GetMigrationRangeForVersion(version string) (from, to int, found bool) {
	for i := len(VersionMigrationMap) - 1; i >= 0; i-- {
		vm := VersionMigrationMap[i]
		if vm.Version == version {
			return vm.From, vm.To, true
		}
	}
	return 0, 0, false
}

func GetMigrationsBetweenVersions(fromVersion, toVersion string) (fromMig, toMig int, found bool) {
	fromIdx := -1
	toIdx := -1

	for i, vm := range VersionMigrationMap {
		if vm.Version == fromVersion {
			fromIdx = i
		}
		if vm.Version == toVersion {
			toIdx = i
		}
	}

	if fromIdx == -1 || toIdx == -1 {
		return 0, 0, false
	}

	if fromIdx > toIdx {
		return 0, 0, false
	}

	return VersionMigrationMap[fromIdx].From, VersionMigrationMap[toIdx].To, true
}