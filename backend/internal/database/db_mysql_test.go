//go:build (mysql && !sqlite) || test_mysql

package database_test

import (
	"database/sql"
	"os"
	"testing"

	_ "github.com/go-sql-driver/mysql"
	"open-kanban/internal/database"
)

func TestInitDB_MySQL(t *testing.T) {
	os.Setenv("DB_TYPE", "mysql")
	os.Setenv("DB_HOST", "10.0.1.240")
	os.Setenv("DB_PORT", "3306")
	os.Setenv("DB_USER", "test")
	os.Setenv("DB_PASSWORD", "password")
	os.Setenv("DB_NAME", "test")
	os.Setenv("DB_MAX_OPEN_CONNS", "10")
	os.Setenv("DB_MAX_IDLE_CONNS", "5")
	os.Setenv("DB_CONN_MAX_LIFETIME", "300")

	db, err := database.InitDB()
	if err != nil {
		t.Fatalf("failed to init MySQL db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Errorf("failed to ping MySQL database: %v", err)
	}

	var version string
	err = db.QueryRow("SELECT VERSION()").Scan(&version)
	if err != nil {
		t.Errorf("failed to query MySQL version: %v", err)
	}
	if version == "" {
		t.Error("expected non-empty MySQL version")
	}

	_, err = db.Exec("SELECT 1")
	if err != nil {
		t.Errorf("failed to execute simple query: %v", err)
	}
}

func TestMySQLConnection(t *testing.T) {
	dsn := "test:password@tcp(10.0.1.240:3306)/test?parseTime=true&charset=utf8mb4"
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("failed to open MySQL connection: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Errorf("failed to ping MySQL server: %v", err)
	}

	var result int
	err = db.QueryRow("SELECT 1").Scan(&result)
	if err != nil {
		t.Errorf("failed to execute query: %v", err)
	}
	if result != 1 {
		t.Errorf("expected result 1, got %d", result)
	}
}

func TestGetDBConfig_MySQL(t *testing.T) {
	os.Setenv("DB_TYPE", "mysql")
	os.Setenv("DB_HOST", "myhost")
	os.Setenv("DB_PORT", "3307")
	os.Setenv("DB_USER", "myuser")
	os.Setenv("DB_PASSWORD", "mypass")
	os.Setenv("DB_NAME", "mydb")
	os.Setenv("DATABASE_URL", "")
	os.Setenv("DB_MAX_OPEN_CONNS", "10")
	os.Setenv("DB_MAX_IDLE_CONNS", "3")
	os.Setenv("DB_CONN_MAX_LIFETIME", "600")

	config := database.GetDBConfig()

	if config.Type != "mysql" {
		t.Errorf("expected type 'mysql', got '%s'", config.Type)
	}
	if config.Host != "myhost" {
		t.Errorf("expected host 'myhost', got '%s'", config.Host)
	}
	if config.Port != "3307" {
		t.Errorf("expected port '3307', got '%s'", config.Port)
	}
	if config.User != "myuser" {
		t.Errorf("expected user 'myuser', got '%s'", config.User)
	}
	if config.Password != "mypass" {
		t.Errorf("expected password 'mypass', got '%s'", config.Password)
	}
	if config.Database != "mydb" {
		t.Errorf("expected database 'mydb', got '%s'", config.Database)
	}
	if config.MaxOpenConns != 10 {
		t.Errorf("expected MaxOpenConns 10, got %d", config.MaxOpenConns)
	}
	if config.MaxIdleConns != 3 {
		t.Errorf("expected MaxIdleConns 3, got %d", config.MaxIdleConns)
	}
	if config.ConnMaxLifetime != 600 {
		t.Errorf("expected ConnMaxLifetime 600, got %d", config.ConnMaxLifetime)
	}
}
