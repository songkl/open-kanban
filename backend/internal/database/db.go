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

func init() {
	// The default build (no build tags) ships both drivers, so register
	// both. The mysql-only and sqlite-only build variants register their
	// single driver in db_mysql.go / db_sqlite.go instead.
	registerDBType("mysql")
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

// buildMySQLDSN returns the DSN used for the application's MySQL connection.
// multiStatements=true is required because golang-migrate sends each .sql
// file as one Exec call; without it, MySQL rejects the file at the second
// statement with a 1064 syntax error.
func buildMySQLDSN(config *DBConfig) string {
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4&multiStatements=true",
		config.User, config.Password, config.Host, config.Port, config.Database)
}

// BuildMySQLDSNForTest exposes buildMySQLDSN for tests.
func BuildMySQLDSNForTest(config *DBConfig) string {
	return buildMySQLDSN(config)
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

	dsn := buildMySQLDSN(config)

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

	// Schema drift detection (s-1217). golang-migrate records every
	// applied migration in `schema_migrations.version` and
	// `m.Up()` short-circuits to ErrNoChange when the recorded
	// version is already at-or-above the latest embedded migration.
	// That is the right behaviour for a healthy DB, but it hides a
	// corrupt state where someone (or an earlier partial run) set
	// `schema_migrations.version` to a high number without actually
	// applying the schema changes — the recorded version is
	// untrustworthy and the embedded migrations never re-run on
	// their own.
	//
	// Recovery: compute the *effective* version by inspecting the
	// actual schema (canary tables / columns introduced by each
	// migration), then force the recorded version down to that
	// effective value so the subsequent m.Up() only replays the
	// missing migrations. Migrations that use ALTER TABLE ADD
	// COLUMN (004 / 014) are not naturally idempotent, so a blanket
	// force-NilVersion would re-run them and fail with "duplicate
	// column name"; aligning the recorded version with the effective
	// one skips those re-runs cleanly.
	//
	// When the effective version is 0 (every canary is missing) we
	// force NilVersion (-1) instead of 0 — golang-migrate has no
	// migration for version 0 and `m.Up()` would otherwise hit
	// `versionExists(0)` and bail with "no migration found".
	// NilVersion puts the driver back into the "fresh DB" state
	// where m.Up() starts from the first embedded migration.
	//
	// The canary-based effective version is bounded above by the
	// recorded version, so a healthy DB returns the same number and
	// the runner short-circuits to m.Up() as before.
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
		log.Printf("[SQLite] schema drift detected (recorded version >= 4 but at least one post-004 canary is missing); rewinding recorded version to %d so m.Up() replays only the missing migrations", forceTarget)
		if err := m.Force(forceTarget); err != nil {
			return fmt.Errorf("failed to force migration state after drift detection: %w", err)
		}
	}

	// Always apply every pending migration. The migration files are
	// embedded in the binary, so the runner can only see migrations
	// the binary ships with; capping the run at the version map's
	// `toMig` (e.g. "0.2.0" → 2) would strand a fresh install on a
	// stale git tag and leave the schema out of sync with the code
	// that needs migration 4+ (boards.is_public, audit columns, ...).
	// m.Migrate(toMig) is also dangerous when the DB is already past
	// toMig: golang-migrate would try to migrate DOWN, dropping
	// tables and data. m.Up() only ever moves forward.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
			// Forcing the dirty flag back to NilVersion lets
			// m.Up() re-run the full set from scratch rather
			// than getting stuck in a half-applied state. The
			// migration files are written to be idempotent
			// (CREATE TABLE IF NOT EXISTS, etc.) so re-running
			// them is safe.
			if forceErr := m.Force(-1); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run SQLite migrations: %w", err)
		}
	}

	// Record the binary's git version for observability / upgrade
	// tracking, but only when it's a known release. An unknown
	// version (e.g. "0.2.0-81-gff98edc" from a development
	// checkout) would write a misleading row, so we leave the
	// existing schema_version alone in that case.
	if gitVersion := version.GetGitVersion(); gitVersion != "" {
		if _, _, found := migrations.GetMigrationRangeForVersion(gitVersion); found {
			if err := storeSchemaVersion(db, gitVersion); err != nil {
				log.Printf("[SQLite] Warning: failed to store schema version: %v", err)
			}
		} else {
			log.Printf("[SQLite] Skipping schema_version write for unknown git version %q", gitVersion)
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

	// Always apply every pending migration (same rationale as the
	// SQLite path: see the comment in runSQLiteMigrations). The
	// version map is used only for the schema_version log row.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
			if forceErr := m.Force(0); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run MySQL migrations: %w", err)
		}
	}

	if gitVersion := version.GetGitVersion(); gitVersion != "" {
		if _, _, found := migrations.GetMigrationRangeForVersion(gitVersion); found {
			if err := storeMySQLSchemaVersion(db, gitVersion); err != nil {
				log.Printf("[MySQL] Warning: failed to store schema version: %v", err)
			}
		} else {
			log.Printf("[MySQL] Skipping schema_version write for unknown git version %q", gitVersion)
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
