# Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for Open-Kanban.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences. ADRs help:
- Document design decisions for future reference
- Track the evolution of the system architecture
- Onboard new team members
- Avoid revisiting the same discussions

## ADR Format

Each ADR includes:

- **Status** - Current state (Proposed, Accepted, Deprecated, Superseded)
- **Context** - The situation and forces at play
- **Decision** - The chosen solution
- **Consequences** - Trade-offs and outcomes
- **References** - Related documents

## ADR Index

| ID | Title | Status |
|----|-------|--------|
| [ADR-0001](ADR-0001-use-go-gin-framework.md) | Use Go with Gin Framework | Accepted |
| [ADR-0002](ADR-0002-use-sqlite-database.md) | Use SQLite Database | Accepted |
| [ADR-0003](ADR-0003-token-based-authentication.md) | Token-Based Authentication | Accepted |
| [ADR-0004](ADR-0004-websocket-real-time-updates.md) | WebSocket for Real-Time Updates | Accepted |
| [ADR-0005](ADR-0005-multi-agent-support.md) | Multi-Agent Support Architecture | Accepted |

## Creating a New ADR

1. Copy the template below
2. Name the file `ADR-XXXX-title.md`
3. Use the next available number
4. Set status to "Proposed"
5. Submit for review

## ADR Template

```markdown
# ADR-XXXX: Title

## Status

Proposed

## Context

Describe the situation and forces at play.

## Decision

Describe the response to these forces.

## Alternatives Considered

List alternatives that were considered.

## Consequences

### Positive
...

### Negative
...

## References

Link to related documents.
```
