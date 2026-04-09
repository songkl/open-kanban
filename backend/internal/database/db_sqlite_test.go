//go:build sqlite && !mysql

package database_test

import (
	"os"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"open-kanban/internal/database"
)

func TestGetDBConfig_DefaultSQLite(t *testing.T) {
	os.Setenv("DB_TYPE", "")
	os.Setenv("DB_HOST", "")
	os.Setenv("DB_PORT", "")
	os.Setenv("DB_USER", "")
	os.Setenv("DB_PASSWORD", "")
	os.Setenv("DB_NAME", "")
	os.Setenv("DATABASE_URL", "")
	os.Setenv("DB_MAX_OPEN_CONNS", "")
	os.Setenv("DB_MAX_IDLE_CONNS", "")
	os.Setenv("DB_CONN_MAX_LIFETIME", "")

	config := database.GetDBConfig()

	if config.Type != "sqlite" {
		t.Errorf("expected type 'sqlite', got '%s'", config.Type)
	}
	if config.Host != "localhost" {
		t.Errorf("expected host 'localhost', got '%s'", config.Host)
	}
	if config.Port != "3306" {
		t.Errorf("expected port '3306', got '%s'", config.Port)
	}
	if config.Database != "kanban" {
		t.Errorf("expected database 'kanban', got '%s'", config.Database)
	}
	if config.Path != "kanban.db" {
		t.Errorf("expected path 'kanban.db', got '%s'", config.Path)
	}
	if config.MaxOpenConns != 25 {
		t.Errorf("expected MaxOpenConns 25, got %d", config.MaxOpenConns)
	}
	if config.MaxIdleConns != 5 {
		t.Errorf("expected MaxIdleConns 5, got %d", config.MaxIdleConns)
	}
	if config.ConnMaxLifetime != 300 {
		t.Errorf("expected ConnMaxLifetime 300, got %d", config.ConnMaxLifetime)
	}
}

func TestGetDBConfig_SQLite(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DB_HOST", "")
	os.Setenv("DB_PORT", "")
	os.Setenv("DATABASE_URL", "/path/to/db.sqlite")

	config := database.GetDBConfig()

	if config.Type != "sqlite" {
		t.Errorf("expected type 'sqlite', got '%s'", config.Type)
	}
	if config.Path != "/path/to/db.sqlite" {
		t.Errorf("expected path '/path/to/db.sqlite', got '%s'", config.Path)
	}
}

func TestGetDBConfig_InvalidMaxOpenConns(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DB_MAX_OPEN_CONNS", "invalid")

	config := database.GetDBConfig()

	if config.MaxOpenConns != 25 {
		t.Errorf("expected default MaxOpenConns 25, got %d", config.MaxOpenConns)
	}
}

func TestGetDBConfig_InvalidMaxIdleConns(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DB_MAX_IDLE_CONNS", "invalid")

	config := database.GetDBConfig()

	if config.MaxIdleConns != 5 {
		t.Errorf("expected default MaxIdleConns 5, got %d", config.MaxIdleConns)
	}
}

func TestGetDBConfig_InvalidConnMaxLifetime(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DB_CONN_MAX_LIFETIME", "invalid")

	config := database.GetDBConfig()

	if config.ConnMaxLifetime != 300 {
		t.Errorf("expected default ConnMaxLifetime 300, got %d", config.ConnMaxLifetime)
	}
}

func TestInitDB_UnsupportedType(t *testing.T) {
	os.Setenv("DB_TYPE", "postgres")

	_, err := database.InitDB()

	if err == nil {
		t.Error("expected error for unsupported database type")
	}
	if err != nil && err.Error() != "unsupported database type: postgres (SQLite build only supports sqlite)" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestInitDB_SQLiteInMemory(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DATABASE_URL", ":memory:")

	db, err := database.InitDB()
	if err != nil {
		t.Fatalf("failed to init SQLite in-memory db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Errorf("failed to ping database: %v", err)
	}

	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").Scan(&count)
	if err != nil {
		t.Errorf("failed to query: %v", err)
	}
	if count == 0 {
		t.Error("expected tables to be created")
	}
}

func TestInitDB_SQLiteWithPath(t *testing.T) {
	os.Setenv("DB_TYPE", "sqlite")
	os.Setenv("DATABASE_URL", "/tmp/test_kanban.db")

	db, err := database.InitDB()
	if err != nil {
		t.Fatalf("failed to init SQLite db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Errorf("failed to ping database: %v", err)
	}

	os.Remove("/tmp/test_kanban.db")
}
