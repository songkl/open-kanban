# ADR-0004: WebSocket for Real-Time Updates

## Status

Accepted

## Context

We needed a mechanism to provide real-time updates when:
- Tasks are created, updated, or deleted
- Tasks move between columns
- Comments are added
- Board structure changes

Traditional polling would be inefficient and slow.

## Decision

We implemented **WebSocket** connections at `/ws` for real-time updates.

### Implementation Details

- Single WebSocket endpoint for all clients
- Server broadcasts refresh events on any data change
- UTF-8 validation on all messages for safety
- Connection heartbeats to detect disconnected clients

### Message Format

```json
{
  "type": "refresh",
  "data": {}
}
```

## Alternatives Considered

1. **Server-Sent Events (SSE)** - Simpler but one-directional only
2. **Long polling** - Higher latency, more server load
3. **WebSocket with separate channels** - More complex, premature optimization
4. **No real-time updates** - Poor user experience

## Consequences

### Positive
- Instant UI updates for all connected clients
- Reduced server load compared to polling
- Better user experience
- Single connection handles all updates

### Negative
- Stateful connections require connection tracking
- More complex scaling (sticky sessions needed)
- WebSocket complexity in load balancer setups

## References

- [MDN WebSocket Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [RFC 6455 - WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
