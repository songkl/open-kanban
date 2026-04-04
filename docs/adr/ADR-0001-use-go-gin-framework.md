# ADR-0001: Use Go with Gin Framework

## Status

Accepted

## Context

We needed to choose a backend technology stack for Open-Kanban that would be:
- Easy to deploy as a single binary
- Efficient for handling real-time WebSocket connections
- Productive for rapid development
- Suitable for self-hosted deployment

## Decision

We chose **Go with the Gin web framework** for the backend.

### Alternatives Considered

1. **Node.js with Express** - Good for JavaScript consistency but larger memory footprint
2. **Python with Flask/FastAPI** - Slower performance, larger deployment footprint
3. **Rust with Actix** - Excellent performance but higher learning curve and slower development
4. **Java/Spring** - Overkill for this project, complex deployment

## Decision Details

**Go benefits for this project:**
- Single binary deployment with no runtime dependencies
- Excellent concurrency support for WebSocket connections
- Built-in SQLite driver (`database/sql` with mattn/go-sqlite3)
- Fast compilation and startup
- Strong standard library
- Gin framework provides Express-like productivity

**Why Gin specifically:**
- Lightweight and fast
- Middleware ecosystem
- RESTful API focus
- Well-documented

## Consequences

### Positive
- Single binary deployment simplifies self-hosting
- Efficient handling of concurrent connections
- Fast cold starts
- Good performance characteristics

### Negative
- Team needed to learn Go (if not already known)
- Less ecosystem for quick features compared to Node.js
- No built-in hot reloading during development

## References

- [Go Documentation](https://go.dev/doc/)
- [Gin Web Framework](https://gin-gonic.com/)
