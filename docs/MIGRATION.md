# Database Migration Guide

open-kanban uses [golang-migrate](https://github.com/golang-migrate/migrate) for database migrations.

## Migration Structure

Migrations are stored in `backend/internal/database/migrations/` with separate directories for each database type:

```
backend/internal/database/migrations/
├── sqlite/
│   ├── 001_initial_schema.up.sql
│   ├── 001_initial_schema.down.sql
│   ├── 002_...
│   └── ...
└── mysql/
    ├── 001_initial_schema.up.sql
    ├── 001_initial_schema.down.sql
    └── ...
```

Each migration has:
- `*.up.sql` - Migration to apply
- `*.down.sql` - Rollback script

## How Migrations Work

Migrations run automatically on server startup via `database.InitDB()`:

1. Server connects to database
2. `migrate.NewWithInstance` creates a migration instance
3. `m.Up()` applies all pending migrations
4. Server starts once migrations complete

## Migration Naming Convention

Format: `XXX_description.up.sql` / `XXX_description.down.sql`

- `XXX` - Sequential number (001, 002, ...)
- `description` - Brief description of the migration

## Creating a New Migration

### 1. Create up migration

Create `backend/internal/database/migrations/sqlite/008_your_migration.up.sql`:

```sql
-- Add new column to tasks table
ALTER TABLE tasks ADD COLUMN new_field TEXT DEFAULT '';
```

### 2. Create down migration

Create `backend/internal/database/migrations/sqlite/008_your_migration.down.sql`:

```sql
-- Rollback: remove column
ALTER TABLE tasks DROP COLUMN new_field;
```

### 3. Create MySQL version

Create `backend/internal/database/migrations/mysql/008_your_migration.up.sql`:

```sql
-- MySQL compatible syntax
ALTER TABLE tasks ADD COLUMN new_field TEXT DEFAULT '' AFTER updated_at;
```

And the corresponding down migration.

## Important Notes

### Dirty Migration State

If a migration fails midway, the database may enter a "dirty" state. The migration runner will automatically attempt to force恢复到干净状态 (run `m.Force(8)`), but you may need to manually fix the migration state in production.

### Testing Migrations

Run SQLite migrations test:

```bash
cd backend
go test ./internal/database/... -run TestSQLiteMigrations -v
```

### Production Considerations

1. **Always test down migrations** before deploying
2. **Backup database** before running migrations in production
3. **Monitor migration time** - long migrations may cause downtime
4. **Use transactions** where supported (MySQL supports DDL in transactions, SQLite does not)

## Manual Migration Control

For advanced users, you can use the migrate CLI:

```bash
# Install migrate
go install -tags 'sqlite' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# Apply migrations
migrate -path internal/database/migrations/sqlite -database "sqlite3://kanban.db" up

# Rollback last migration
migrate -path internal/database/migrations/sqlite -database "sqlite3://kanban.db" down 1

# Check current version
migrate -path internal/database/migrations/sqlite -database "sqlite3://kanban.db" version
```

## Migration History

| # | Description | SQLite | MySQL |
|---|-------------|--------|-------|
| 001 | Initial schema | Yes | Yes |
| 002 | (see files) | Yes | Yes |
| 003 | Attachment access token | Yes | Yes |
| 004 | Performance indexes | Yes | Yes |
| 005 | Task agent fields | Yes | Yes |
| 006 | Username column | Yes | Yes |
| 007 | Boolean to integer conversion | Yes | - |

## Troubleshooting

### "Dirty" database state

```
Dirty migration state detected. Forcing clean state...
```

This occurs when a migration fails. The system will automatically attempt to force恢复到版本 8, but you may need to manually investigate.

### Migration not applying

Check that:
1. Migration files exist in correct location
2. File names match expected pattern
3. SQL syntax is correct for your database type

### Version mismatch

If you see unexpected errors after a migration, verify the migration version:

```bash
sqlite3 kanban.db "PRAGMA user_version;"
```
