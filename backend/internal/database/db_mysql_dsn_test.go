//go:build mysql && !sqlite

package database_test

import (
	"strings"
	"testing"

	"open-kanban/internal/database"
)

// TestBuildMySQLDSNIncludesMultiStatements ensures the DSN used to open the
// MySQL connection has multiStatements=true set. golang-migrate sends each
// .sql migration file as one Exec call; without multiStatements MySQL
// rejects the file at the second statement with a 1064 syntax error.
func TestBuildMySQLDSNIncludesMultiStatements(t *testing.T) {
	cfg := &database.DBConfig{
		User:     "alice",
		Password: "p@ss",
		Host:     "db.example.com",
		Port:     "3306",
		Database: "kanban",
	}

	dsn := database.BuildMySQLDSNForTest(cfg)

	if !strings.Contains(dsn, "multiStatements=true") {
		t.Errorf("expected DSN to contain multiStatements=true for golang-migrate compatibility, got %q", dsn)
	}
	for _, want := range []string{
		"alice:p@ss@tcp(db.example.com:3306)/kanban",
		"parseTime=true",
		"charset=utf8mb4",
	} {
		if !strings.Contains(dsn, want) {
			t.Errorf("expected DSN to contain %q, got %q", want, dsn)
		}
	}
}
