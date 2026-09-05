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
