package database_test

import (
	"database/sql"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/database/migrations"
)

func TestSQLiteMigrations(t *testing.T) {
	db, err := sql.Open("sqlite3", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		t.Fatalf("failed to create sqlite instance: %v", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		t.Fatalf("failed to create migration source: %v", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		t.Fatalf("failed to create migrate instance: %v", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("failed to run migrations: %v", err)
	}

	tables := []string{
		"users", "tokens", "boards", "board_permissions",
		"columns", "column_agents", "tasks", "comments",
		"subtasks", "attachments", "activities", "templates",
		"app_config", "column_permissions",
	}

	for _, table := range tables {
		var name string
		err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
		if err == sql.ErrNoRows {
			t.Errorf("table %s not found", table)
		} else if err != nil {
			t.Errorf("error checking table %s: %v", table, err)
		}
	}

	var accessTokenCol string
	err = db.QueryRow("SELECT access_token FROM attachments LIMIT 1").Scan(&accessTokenCol)
	if err != nil && err != sql.ErrNoRows {
		t.Errorf("access_token column not found in attachments: %v", err)
	}

	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_column_permissions_user'").Scan(&count)
	if err != nil {
		t.Errorf("error checking index: %v", err)
	}
}
