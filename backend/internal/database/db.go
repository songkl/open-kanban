package database

import (
	"database/sql"
	"fmt"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
)

// DBConfig holds database configuration
type DBConfig struct {
	Type     string // "sqlite" or "mysql"
	Host     string
	Port     string
	User     string
	Password string
	Database string
	Path     string // For SQLite
}

// GetDBConfig returns database configuration from environment
func GetDBConfig() *DBConfig {
	dbType := strings.ToLower(os.Getenv("DB_TYPE"))
	if dbType == "" {
		dbType = "sqlite" // Default to SQLite
	}

	return &DBConfig{
		Type:     dbType,
		Host:     getEnvOrDefault("DB_HOST", "localhost"),
		Port:     getEnvOrDefault("DB_PORT", "3306"),
		User:     getEnvOrDefault("DB_USER", "root"),
		Password: os.Getenv("DB_PASSWORD"),
		Database: getEnvOrDefault("DB_NAME", "kanban"),
		Path:     getEnvOrDefault("DATABASE_URL", "kanban.db"),
	}
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// InitDB initializes the database connection
func InitDB() (*sql.DB, error) {
	config := GetDBConfig()

	switch config.Type {
	case "mysql":
		return initMySQL(config)
	case "sqlite":
		return initSQLite(config)
	default:
		return nil, fmt.Errorf("unsupported database type: %s", config.Type)
	}
}

func initSQLite(config *DBConfig) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", config.Path)
	if err != nil {
		return nil, fmt.Errorf("failed to open SQLite database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping SQLite database: %w", err)
	}

	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Run migrations
	if err := runSQLiteMigrations(db); err != nil {
		return nil, fmt.Errorf("failed to run SQLite migrations: %w", err)
	}

	return db, nil
}

func initMySQL(config *DBConfig) (*sql.DB, error) {
	// First, connect without database to create it if needed
	rootDSN := fmt.Sprintf("%s:%s@tcp(%s:%s)/",
		config.User, config.Password, config.Host, config.Port)

	rootDB, err := sql.Open("mysql", rootDSN)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to MySQL server: %w", err)
	}
	defer rootDB.Close()

	// Create database if not exists
	_, err = rootDB.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", config.Database))
	if err != nil {
		return nil, fmt.Errorf("failed to create MySQL database: %w", err)
	}

	// Connect to the specific database
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4",
		config.User, config.Password, config.Host, config.Port, config.Database)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open MySQL database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping MySQL database: %w", err)
	}

	// Run migrations
	if err := runMySQLMigrations(db, config.Database); err != nil {
		return nil, fmt.Errorf("failed to run MySQL migrations: %w", err)
	}

	return db, nil
}

func runSQLiteMigrations(db *sql.DB) error {
	driver, err := sqlite3.WithInstance(db, &sqlite3.Config{})
	if err != nil {
		return fmt.Errorf("failed to create SQLite migration driver: %w", err)
	}

	d, err := iofs.New(migrations.SQLiteFS, "sqlite")
	if err != nil {
		return fmt.Errorf("failed to create SQLite migration source: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, "sqlite3", driver)
	if err != nil {
		return fmt.Errorf("failed to create SQLite migrate instance: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") {
			if forceErr := m.Force(8); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run SQLite migrations: %w", err)
		}
	}

	return nil
}

func runMySQLMigrations(db *sql.DB, databaseName string) error {
	driver, err := mysql.WithInstance(db, &mysql.Config{})
	if err != nil {
		return fmt.Errorf("failed to create MySQL migration driver: %w", err)
	}

	d, err := iofs.New(migrations.MySQLFS, "mysql")
	if err != nil {
		return fmt.Errorf("failed to create MySQL migration source: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", d, databaseName, driver)
	if err != nil {
		return fmt.Errorf("failed to create MySQL migrate instance: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") {
			if forceErr := m.Force(8); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run MySQL migrations: %w", err)
		}
	}

	return nil
}
