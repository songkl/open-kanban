package database

import (
	"open-kanban/internal/version"
)

// isDevGitBuild returns true when the git describe output for HEAD
// carries a "-N-gXXXX" suffix that places the commit past the closest
// tag — i.e. the binary was built from an unreleased development
// commit. Production builds (HEAD == tag, no suffix) return false and
// continue to honour VersionMigrationMap so operators keep explicit
// control over which migrations ship in each release.
//
// The function lives in its own file so the per-driver build-tag
// variants (db_sqlite.go / db_mysql.go) and the combined build
// (db.go) all share the same definition without duplicating it under
// every //go:build directive.
func isDevGitBuild() bool {
	full := version.GetFullGitVersion()
	tag := version.GetGitVersion()
	if full == "" || tag == "" {
		return false
	}
	return full != tag
}
