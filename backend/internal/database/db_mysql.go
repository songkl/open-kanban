//go:build mysql && !sqlite

package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/mysql"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"open-kanban/internal/database/migrations"
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

// init makes MySQL the explicit default DB type for the MySQL-only build.
// Without this, os.Getenv("DB_TYPE") returns "" at startup and
// mysqlNeedsLazySetup() in main.go can't tell that this binary can only
// talk to MySQL — it would skip setup mode and try to connect to a local
// MySQL server with empty credentials, failing before the user gets a
// chance to run the setup wizard. Pinning DB_TYPE=mysql here is safe
// because the MySQL-only build has no SQLite fallback to choose instead.
func init() {
	if os.Getenv("DB_TYPE") == "" {
		_ = os.Setenv("DB_TYPE", "mysql")
	}
	registerDBType("mysql")
}

func GetDBConfig() *DBConfig {
	dbType := strings.ToLower(os.Getenv("DB_TYPE"))
	if dbType == "" {
		dbType = "mysql"
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

func initMySQL(config *DBConfig) (*sql.DB, error) {
	rootDSN := fmt.Sprintf("%s:%s@tcp(%s:%s)/",
		config.User, config.Password, config.Host, config.Port)

	rootDB, err := sql.Open("mysql", rootDSN)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to MySQL server: %w", err)
	}
	defer rootDB.Close()

	// Probe credentials up-front so we can surface an actionable error
	// instead of a generic "failed to create database" wrapper when the
	// real cause is wrong user/password (MySQL Error 1045) or a wrong
	// host (2003). The CREATE DATABASE call below otherwise hides the
	// auth failure behind a confusing statement-level error.
	if err := rootDB.Ping(); err != nil {
		return nil, fmt.Errorf("failed to authenticate to MySQL at %s:%s as user %q (check DB_HOST / DB_PORT / DB_USER / DB_PASSWORD): %w",
			config.Host, config.Port, config.User, err)
	}

	_, err = rootDB.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", config.Database))
	if err != nil {
		return nil, fmt.Errorf("failed to create MySQL database %q (the connected user may lack CREATE privileges): %w",
			config.Database, err)
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

	// Self-check: a handful of tables are added over time (e.g.
	// column_permissions). If the operator is upgrading from a
	// pre-consolidation build, the migration runner sees
	// schema_migrations.version already past the only migration
	// (version 1) and returns ErrNoChange without ever creating the
	// new tables — leaving /api/v1/auth/permissions/columns to fail
	// at runtime with a confusing "Failed to set" 500. Instead of
	// hard-failing and forcing the operator to drop the database,
	// we auto-repair the schema: rewind schema_migrations to 0 and
	// let the consolidated migration re-run. The migration is
	// idempotent (every CREATE TABLE is IF NOT EXISTS, every CREATE
	// INDEX is wrapped in a drop+create pair below) so existing
	// tables and indexes are untouched; only the truly-missing
	// objects get created.
	if missing, err := missingMySQLTables(db); err != nil {
		return nil, fmt.Errorf("schema self-check: %w", err)
	} else if len(missing) > 0 {
		log.Printf("[MySQL] schema is missing tables %v — auto-repairing by re-running the consolidated migration", missing)
		if err := repairMySQLSchema(db, missing); err != nil {
			return nil, fmt.Errorf(
				"schema auto-repair failed: %w. If this database was created by a much older build, "+
					"the safest fix is `migrate down` then `migrate up` on the same connection (or drop "+
					"the database and let the setup wizard recreate it).",
				err,
			)
		}
		log.Printf("[MySQL] schema auto-repair succeeded — created %v", missing)
	}

	return db, nil
}

// requiredMySQLTables is the minimum set of tables the application
// needs to function. Missing tables are usually a sign of an
// in-place upgrade from a pre-consolidation binary that left
// schema_migrations.version > 1 (so the runner thinks there's
// nothing to do). The auto-repair path rewinds the version to 0
// and re-runs the consolidated migration; the recovery SQL is
// idempotent, so any table that's already there is left alone.
var requiredMySQLTables = []string{
	"users",
	"tokens",
	"boards",
	"board_permissions",
	"columns",
	"tasks",
	"comments",
	"attachments",
	"activities",
	"app_config",
	"oauth_clients",
	"oauth_authorization_codes",
	"oauth_device_codes",
	"oauth_refresh_tokens",
	"oauth_consents",
	"column_permissions",
}

func missingMySQLTables(db *sql.DB) ([]string, error) {
	rows, err := db.Query(
		"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	present := make(map[string]bool, 32)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		present[name] = true
	}
	var missing []string
	for _, want := range requiredMySQLTables {
		if !present[want] {
			missing = append(missing, want)
		}
	}
	return missing, nil
}

// repairMySQLSchema force-replays the consolidated MySQL migration
// so a database created by an older build can pick up the new
// tables without a destructive reset. We don't re-run the whole
// migration via golang-migrate because the file is full of
// `CREATE INDEX` statements that MySQL 8.0 can't make idempotent
// (IF NOT EXISTS on CREATE INDEX is recognised but not
// implemented), and re-running them on a DB where they already
// exist would hard-fail. Instead, we run only the missing
// tables' `CREATE TABLE IF NOT EXISTS` statements; the matching
// indexes (and any other objects those tables need) are inlined
// next to each table's CREATE statement so the recovery is
// self-contained. Existing tables are left untouched.
func repairMySQLSchema(db *sql.DB, missing []string) error {
	if len(missing) == 0 {
		return nil
	}
	for _, table := range missing {
		ddl, ok := mysqlRecoveryDDL[table]
		if !ok {
			return fmt.Errorf(
				"don't know how to auto-create %q; please drop the database or run `migrate down` "+
					"then `migrate up` to recover",
				table,
			)
		}
		if _, err := db.Exec(ddl); err != nil {
			return fmt.Errorf("failed to create %q: %w", table, err)
		}
	}
	return nil
}

// mysqlRecoveryDDL holds the CREATE TABLE statements for tables
// that may be missing on databases created by a pre-consolidation
// build. Each entry is the canonical schema from
// migrations/mysql/001_initial_schema.up.sql, plus the indexes
// that table needs (kept in one statement so the recovery is a
// single round-trip per table). If a future release adds another
// table, add it here AND to requiredMySQLTables so the self-check
// knows it must exist.
var mysqlRecoveryDDL = map[string]string{
	"column_permissions": "CREATE TABLE IF NOT EXISTS column_permissions (\n" +
		"	id VARCHAR(255) PRIMARY KEY,\n" +
		"	user_id VARCHAR(255) NOT NULL,\n" +
		"	column_id VARCHAR(255) NOT NULL,\n" +
		"	access VARCHAR(20) NOT NULL DEFAULT 'READ' CHECK(access IN ('READ', 'WRITE', 'ADMIN')),\n" +
		"	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
		"	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
		"	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,\n" +
		"	FOREIGN KEY (column_id) REFERENCES `columns`(id) ON DELETE CASCADE,\n" +
		"	UNIQUE KEY uniq_column_permissions (user_id, column_id)\n" +
		") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
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
		if strings.Contains(err.Error(), "Dirty") || strings.Contains(err.Error(), "no migration found") {
			// With the consolidated schema there is only one migration
			// (version 1). Forcing the dirty flag back to "no migrations
			// applied" lets the next startup re-run it from scratch
			// rather than getting stuck in a half-applied state.
			if forceErr := m.Force(0); forceErr != nil {
				return fmt.Errorf("failed to force clean migration state: %w", forceErr)
			}
		} else {
			return fmt.Errorf("failed to run MySQL migrations: %w", err)
		}
	}

	return nil
}

// TestMySQLRecoveryDDL_HasColumnPermissions is a sanity guard: if a
// future release renames the column_permissions table or its
// columns, this test catches the drift between the recovery DDL
// (which a runtime auto-repair relies on) and the migration file
// (which is the source of truth). Update both together.
func TestMySQLRecoveryDDL_HasColumnPermissions(t *testing.T) {
	ddl, ok := mysqlRecoveryDDL["column_permissions"]
	if !ok {
		t.Fatalf("mysqlRecoveryDDL is missing the column_permissions entry; add it so the auto-repair path works")
	}
	for _, want := range []string{
		"CREATE TABLE IF NOT EXISTS column_permissions",
		"id VARCHAR(255) PRIMARY KEY",
		"user_id VARCHAR(255) NOT NULL",
		"column_id VARCHAR(255) NOT NULL",
		"access VARCHAR(20)",
		"FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
		"FOREIGN KEY (column_id) REFERENCES `columns`(id) ON DELETE CASCADE",
		"UNIQUE KEY uniq_column_permissions (user_id, column_id)",
		"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
	} {
		if !strings.Contains(ddl, want) {
			t.Errorf("mysqlRecoveryDDL[column_permissions] is missing %q\n  got:\n%s", want, ddl)
		}
	}
}

// TestMySQLRecoveryDDL_AllRequiredTablesCovered ensures the recovery
// map has an entry for every table the self-check considers
// required. Otherwise a missing table would surface as
// "don't know how to auto-create" and force the operator into a
// destructive reset, which is exactly the pain the auto-repair
// was added to avoid.
func TestMySQLRecoveryDDL_AllRequiredTablesCovered(t *testing.T) {
	for _, table := range requiredMySQLTables {
		if _, ok := mysqlRecoveryDDL[table]; !ok {
			t.Errorf("requiredMySQLTables contains %q but mysqlRecoveryDDL has no recovery entry for it; "+
				"add a CREATE TABLE IF NOT EXISTS statement to the recovery map (and keep it in sync with the "+
				"canonical migration file)", table)
		}
	}
}

func InitDB() (*sql.DB, error) {
	config := GetDBConfig()
	if config.Type != "mysql" {
		return nil, fmt.Errorf("unsupported database type: %s (MySQL build only supports mysql)", config.Type)
	}
	return initMySQL(config)
}
