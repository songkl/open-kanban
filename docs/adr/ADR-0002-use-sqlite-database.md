# ADR-0002: Use SQLite Database

## Status

Accepted

## Context

We needed a database solution that would:
- Support self-hosted deployment without external dependencies
- Handle typical kanban board workloads efficiently
- Require minimal administration
- Be portable across platforms

## Decision

We chose **SQLite** as the database for Open-Kanban.

### Alternatives Considered

1. **PostgreSQL** - Excellent database but requires separate server process
2. **MySQL/MariaDB** - Requires server process, more complex setup
3. **MongoDB** - NoSQL approach less suitable for relational kanban data
4. **Embedded key-value stores (Badger, BoltDB)** - Good for simple data but lack query flexibility

## Decision Details

**SQLite benefits for this project:**
- Zero-configuration, embedded database
- Single file storage (easy backup and transfer)
- Perfect for single-user or small multi-user scenarios
- Sufficient performance for kanban workloads (< 100k tasks)
- ACID compliant with transactions
- No server process to manage

**Trade-offs accepted:**
- Write locking (acceptable for kanban use case)
- Limited concurrent write support (not an issue for typical usage)
- No network connectivity (embedded is a feature for self-hosting)

## Consequences

### Positive
- True self-hosted deployment with no database server setup
- Single file backup and restore
- Portable database file
- Excellent read performance
- Zero administration overhead

### Negative
- Not suitable for high-write concurrent workloads
- No remote access (could be mitigated with external tools)
- Write contention under heavy concurrent updates

## References

- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [When to Use SQLite](https://www.sqlite.org/whentouse.html)
