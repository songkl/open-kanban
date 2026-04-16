//go:build !mysql && !sqlite

package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/database/migrations"
	"open-kanban/internal/version"
)

type DBConfig struct {
	Type            string
	Host            string
	Port            string
	User            string
	Password        string
	Database        string
	Path            string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime int
}

func GetDBConfig() *DBConfig {
	dbType := strings.ToLower(os.Getenv("DB_TYPE"))
	if dbType == "" {
		dbType = "sqlite"
	}

	return &DBConfig{
		Type:            dbType,
		Host:            getEnvOrDefault("DB_HOST", "localhost"),
		Port:            getEnvOrDefault("DB_PORT", "3306"),
		User:            getEnvOrDefault("DB_USER", "root"),
		Password:        os.Getenv("DB_PASSWORD"),
		Database:        getEnvOrDefault("DB_NAME", "kanban"),
		Path:            getEnvOrDefault("DATABASE_URL", "kanban.db"),
		MaxOpenConns:    getEnvOrDefaultInt("DB_MAX_OPEN_CONNS", 25),
		MaxIdleConns:    getEnvOrDefaultInt("DB_MAX_IDLE_CONNS", 5),
		ConnMaxLifetime: getEnvOrDefaultInt("DB_CONN_MAX_LIFETIME", 300),
	}
}

func getEnvOrDefaultInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		var intValue int
		if _, err := fmt.Sscanf(value, "%d", &intValue); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

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

	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	if err := runSQLiteMigrations(db); err != nil {
		return nil, fmt.Errorf("failed to run SQLite migrations: %w", err)
	}

	return db, nil
}

func initMySQL(config *DBConfig) (*sql.DB, error) {
	rootDSN := fmt.Sprintf("%s:%s@tcp(%s:%s)/",
		config.User, config.Password, config.Host, config.Port)

	rootDB, err := sql.Open("mysql", rootDSN)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to MySQL server: %w", err)
	}
	defer func() { _ = rootDB.Close() }()

	_, err = rootDB.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", config.Database))
	if err != nil {
		return nil, fmt.Errorf("failed to create MySQL database: %w", err)
	}

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4",
		config.User, config.Password, config.Host, config.Port, config.Database)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open MySQL database: %w", err)
	}

	db.SetMaxOpenConns(config.MaxOpenConns)
	db.SetMaxIdleConns(config.MaxIdleConns)
	db.SetConnMaxLifetime(time.Duration(config.ConnMaxLifetime) * time.Second)

	log.Printf("[MySQL] Connection pool configured: MaxOpenConns=%d, MaxIdleConns=%d, ConnMaxLifetime=%ds",
		config.MaxOpenConns, config.MaxIdleConns, config.ConnMaxLifetime)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping MySQL database: %w", err)
	}

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

	gitVersion := version.GetGitVersion()
	if gitVersion != "" {
		if fromMig, toMig, found := migrations.GetMigrationRangeForVersion(gitVersion); found {
			log.Printf("[SQLite] Running migrations from version %s (migrations %d to %d)", gitVersion, fromMig, toMig)
			if err := m.Migrate(uint(toMig)); err != nil && err != migrate.ErrNoChange {
				if strings.Contains(err.Error(), "Dirty") {
					if forceErr := m.Force(toMig); forceErr != nil {
						return fmt.Errorf("failed to force clean migration state: %w", forceErr)
					}
				} else if strings.Contains(err.Error(), "no migration found") {
					log.Printf("[SQLite] Migration %d not found, forcing to current version", toMig)
					if forceErr := m.Force(toMig - 1); forceErr != nil {
						return fmt.Errorf("failed to force clean migration state: %w", forceErr)
					}
				} else {
					return fmt.Errorf("failed to run SQLite migrations: %w", err)
				}
			}
			if err := storeSchemaVersion(db, gitVersion); err != nil {
				log.Printf("[SQLite] Warning: failed to store schema version: %v", err)
			}
			return nil
		}
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
			if forceErr := m.Force(7); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run SQLite migrations: %w", err)
		}
	}

	return nil
}

func storeSchemaVersion(db *sql.DB, ver string) error {
	_, err := db.Exec("CREATE TABLE IF NOT EXISTS schema_version (version TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))", ver)
	return err
}

func getStoredSchemaVersion(db *sql.DB) (string, error) {
	var version string
	err := db.QueryRow("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1").Scan(&version)
	if err != nil {
		return "", err
	}
	return version, nil
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

	gitVersion := version.GetGitVersion()
	if gitVersion != "" {
		if fromMig, toMig, found := migrations.GetMigrationRangeForVersion(gitVersion); found {
			log.Printf("[MySQL] Running migrations from version %s (migrations %d to %d)", gitVersion, fromMig, toMig)
			if err := m.Migrate(uint(toMig)); err != nil && err != migrate.ErrNoChange {
				if strings.Contains(err.Error(), "Dirty") {
					if forceErr := m.Force(toMig); forceErr != nil {
						return fmt.Errorf("failed to force clean migration state: %w", forceErr)
					}
				} else if strings.Contains(err.Error(), "no migration found") {
					log.Printf("[MySQL] Migration %d not found, forcing to current version", toMig)
					if forceErr := m.Force(toMig - 1); forceErr != nil {
						return fmt.Errorf("failed to force clean migration state: %w", forceErr)
					}
				} else {
					return fmt.Errorf("failed to run MySQL migrations: %w", err)
				}
			}
			if err := storeMySQLSchemaVersion(db, gitVersion); err != nil {
				log.Printf("[MySQL] Warning: failed to store schema version: %v", err)
			}
			return nil
		}
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
			if forceErr := m.Force(7); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run MySQL migrations: %w", err)
		}
	}

	return nil
}

func storeMySQLSchemaVersion(db *sql.DB, ver string) error {
	_, err := db.Exec("CREATE TABLE IF NOT EXISTS schema_version (version VARCHAR(255) PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO schema_version (version, applied_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE version = VALUES(version), applied_at = VALUES(applied_at)", ver)
	return err
}
