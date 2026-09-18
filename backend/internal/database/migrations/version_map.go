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
	// 0.4.0 added migration 004 to introduce boards.is_public so the
	// board list endpoint can hide private boards from anonymous and
	// unauthorized users. Defaults to 1 so existing boards stay
	// publicly visible after upgrade.
	{Version: "0.4.0", From: 1, To: 4},
	// 0.5.0 added migration 005 to extend the activities.action CHECK
	// constraint with PERMISSION_TRANSFER so the new TransferOwnership
	// handler (POST /api/v1/auth/permissions/transfer-ownership) can
	// record its activity row when a board owner hands ownership to
	// another user. See docs/PERMISSION_MATRIX.md section 4.8.
	{Version: "0.5.0", From: 1, To: 5},
	// 0.6.0 added migration 006 to extend the activities.action CHECK
	// constraint with PERMISSION_BULK_GRANT so the new
	// BulkSetPermissions handler (POST /api/v1/auth/permissions/bulk)
	// can record a single activity row per batch grant.
	{Version: "0.6.0", From: 1, To: 6},
	// 0.7.0 added migration 007 to widen comments.content from TEXT
	// (max 65,535 bytes on MySQL) to LONGTEXT (max 4 GiB) so the
	// CreateComment handler can accept arbitrarily long comment bodies
	// without the storage layer truncating or rejecting the INSERT.
	// SQLite side is documentation-only because SQLite TEXT is already
	// variable-length. Tracked as s-1018.
	{Version: "0.7.0", From: 1, To: 7},
	// 0.8.0 added migration 008 to add audit / lifecycle columns to
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
	{Version: "0.8.0", From: 1, To: 8},
	// 0.9.0 added migration 009 to introduce the notifications table
	// that powers the in-app notification center (PM_REVIEW §5.2 ROI
	// #2). Rows are fan-out inserts by the handlers in
	// internal/handlers/notifications.go and surface as a bell-badge
	// stream driven by the existing WebSocket connection. Tracked
	// as s-1194.
	{Version: "0.9.0", From: 1, To: 9},
	// 0.10.0 added migration 010 to introduce the preset_templates
	// table that backs the first-login wizard and the public template
	// marketplace (PM_REVIEW §5.4 ROI #4 / §6). The table is seeded
	// with at least 4 starter presets (product iteration, bug triage,
	// content calendar, customer support) by the migration itself, so a
	// fresh install lands on a populated marketplace without any manual
	// configuration. Tracked as s-1196.
	{Version: "0.10.0", From: 1, To: 10},
	// 0.11.0 added migration 011 to give column_agents a
	// transition_trigger flag (none / on_enter / on_exit / both) so
	// the SetColumnAgent handler can wake a bound Agent automatically
	// when a task crosses the column boundary. Tracked as s-1214
	// (PM_REVIEW §3.5).
	{Version: "0.11.0", From: 1, To: 11},
	// 0.12.0 added migration 012 to introduce the
	// user_notification_preferences table that backs the new
	// "Notifications" section in Settings (PM_REVIEW §3.7). One row
	// per user with email_enabled / webhook_enabled flags plus a
	// webhook_url, so each delivery channel can be muted
	// independently. Tracked as s-1203.
	{Version: "0.12.0", From: 1, To: 12},
	// 0.13.0 added migration 013 to introduce the viewer_tokens
	// table that backs the public read-only share link + iframe
	// embed surface for boards (PM_REVIEW §6). One row per minted
	// token; the secret value is stored as a SHA-256 hash and the
	// plaintext is only returned ONCE at mint time, the same way
	// the regular /api/v1/auth/token endpoint behaves. Tracked as
	// s-1204.
	{Version: "0.13.0", From: 1, To: 13},
	// 0.14.0 added migration 014 to introduce the tasks.due_at
	// column so a freshly created task can carry a due date
	// straight through the create-task modal into the storage
	// layer (PM_REVIEW §3.12). The column is nullable; existing
	// rows are backfilled with NULL. The idx_tasks_due_at index
	// is built in the same migration so the upcoming "overdue /
	// due in next N days" surface can be served by a plain index
	// scan. Tracked as T-1207 / s-1207.
	{Version: "0.14.0", From: 1, To: 14},
	// 0.15.0 added migration 015 to extend the activities.action
	// CHECK constraint with BULK_ARCHIVE_COLUMN /
	// BULK_COMPLETE_COLUMN so the new BulkColumnAction handler
	// (POST /api/v1/tasks/bulk/column-action) can record a single
	// audit-log row per column-level "Archive all" / "Mark all as
	// completed" action surfaced by the new column-header
	// 3-dot menu. Tracked as s-1212.
	{Version: "0.15.0", From: 1, To: 15},
	// 0.16.0 added migration 016 to introduce the frontend_events
	// table that backs the new Sentry-compatible error sink at
	// /api/v1/frontend-events (PM_REVIEW_2026-09-17 §7). One row per
	// unhandled React error / window.onerror / unhandledrejection
	// captured by the root ErrorBoundary + global handlers. The
	// handler runs the same secret-redaction pass on the client
	// payload that the client runs itself, so a future client
	// regression cannot leak a credential into the database.
	// Tracked as s-1210.
	{Version: "0.16.0", From: 1, To: 16},
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
