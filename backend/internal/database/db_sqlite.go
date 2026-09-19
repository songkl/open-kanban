//go:build sqlite && !mysql

package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/golang-migrate/migrate/v4"
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

func init() {
	registerDBType("sqlite")
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

	if drift, err := sqliteSchemaDrift(db); err != nil {
		return fmt.Errorf("failed to check for schema drift: %w", err)
	} else if drift {
		effective, err := sqliteEffectiveMigrationVersion(db)
		if err != nil {
			return fmt.Errorf("failed to compute effective migration version for drift repair: %w", err)
		}
		forceTarget := effective
		if forceTarget <= 0 {
			forceTarget = -1
		}
		log.Printf("[SQLite] schema drift detected; rewinding recorded version to %d so m.Up() replays only the missing migrations", forceTarget)
		if err := m.Force(forceTarget); err != nil {
			return fmt.Errorf("failed to force migration state after drift detection: %w", err)
		}
	}

	// Dev builds (commits past the closest tag) skip VersionMigrationMap
	// and run every embedded migration file so locally-developed schema
	// changes (e.g. 008 users.created_by from s-1131) are applied on
	// startup. See db.go's isDevGitBuild for the detection rule.
	if isDevGitBuild() {
		log.Printf("[SQLite] Dev build detected (%s > %s), running all embedded migrations",
			version.GetFullGitVersion(), version.GetGitVersion())
		if err := m.Up(); err != nil && err != migrate.ErrNoChange {
			if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
				if forceErr := m.Force(0); forceErr != nil {
					return fmt.Errorf("failed to force clean migration state: %w", forceErr)
				}
			} else {
				return fmt.Errorf("failed to run SQLite migrations: %w", err)
			}
		}
		return nil
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
			if forceErr := m.Force(-1); forceErr != nil {
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

func InitDB() (*sql.DB, error) {
	config := GetDBConfig()
	if config.Type != "sqlite" {
		return nil, fmt.Errorf("unsupported database type: %s (SQLite build only supports sqlite)", config.Type)
	}
	return initSQLite(config)
}
