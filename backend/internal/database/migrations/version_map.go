package migrations

type VersionMigration struct {
	Version string
	From    int
	To      int
}

var VersionMigrationMap = []VersionMigration{
	{Version: "0.1.0", From: 1, To: 8},
	{Version: "0.1.1", From: 8, To: 8},
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
