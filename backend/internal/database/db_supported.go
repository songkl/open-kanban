package database

// supportedDBTypes is populated at init time by the per-driver files
// (db_mysql.go, db_sqlite.go). Each driver file uses a build tag so only
// the drivers compiled into the current binary register here. This lets
// the setup wizard ask "which DB engines does this binary actually
// support?" without having to inspect build tags at runtime.
var supportedDBTypes []string

// registerDBType is called from per-driver init()s and is safe to call
// from any goroutine before SupportedDBTypes is read.
func registerDBType(name string) {
	supportedDBTypes = append(supportedDBTypes, name)
}

// SupportedDBTypes returns the list of database engines compiled into
// this binary, in the order they were registered. The result is stable
// for the lifetime of the process — it is computed once during init.
func SupportedDBTypes() []string {
	out := make([]string, len(supportedDBTypes))
	copy(out, supportedDBTypes)
	return out
}
