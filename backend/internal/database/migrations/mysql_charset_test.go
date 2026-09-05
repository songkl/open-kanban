package migrations

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestMySQLMigrationsHaveUtf8Mb4Collation guards against the bug fixed
// in migration 010: CREATE TABLE statements that omit the table-level
// ENGINE/CHARSET/COLLATE clause inherit MySQL 8.0+'s server default
// (utf8mb4_0900_ai_ci), which is incompatible with the utf8mb4_unicode_ci
// columns produced by migration 001. The resulting FOREIGN KEY
// references to users.id fail with Error 3780.
//
// Every CREATE TABLE in a MySQL *.up.sql must end with the explicit
// "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
// (or equivalent) clause, so the migration produces tables whose FK
// columns can point at users.id without a collation mismatch.
func TestMySQLMigrationsHaveUtf8Mb4Collation(t *testing.T) {
	entries, err := fs.ReadDir(MySQLFS, "mysql")
	if err != nil {
		t.Fatalf("failed to read mysql migrations: %v", err)
	}

	// Captures the column-list body of a CREATE TABLE statement, e.g.
	// everything between "CREATE TABLE ..." and the closing ")". This
	// is the slice we'll check for an ENGINE/CHARSET clause.
	createTableRe := regexp.MustCompile(`(?is)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.]*\s*\((.*?)\)\s*(.*?);`)

	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		data, err := fs.ReadFile(MySQLFS, filepath.Join("mysql", name))
		if err != nil {
			t.Errorf("%s: read failed: %v", name, err)
			continue
		}
		body := string(data)

		for _, match := range createTableRe.FindAllStringSubmatch(body, -1) {
			tail := match[2]
			hasCharset := strings.Contains(tail, "CHARSET=utf8mb4") &&
				strings.Contains(tail, "COLLATE=utf8mb4_unicode_ci") &&
				strings.Contains(tail, "ENGINE=InnoDB")
			if !hasCharset {
				// Snip the table name for a more helpful error.
				head := match[0]
				if len(head) > 80 {
					head = head[:80] + "..."
				}
				t.Errorf(
					"%s: CREATE TABLE missing `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`\n  %s\n  "+
						"Without it MySQL 8.0+ assigns utf8mb4_0900_ai_ci, breaking FOREIGN KEY references to users.id "+
						"(see migration 010 for the fix).",
					name, head,
				)
			}
		}
	}
}
