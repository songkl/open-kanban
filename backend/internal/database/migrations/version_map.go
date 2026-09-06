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
