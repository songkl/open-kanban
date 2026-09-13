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
