# ADR-0003: Token-Based Authentication

## Status

Accepted

## Context

We needed an authentication mechanism that would:
- Support multiple users with different roles
- Enable API access for external integrations
- Work with multi-agent systems
- Be simple to implement and use

## Decision

We implemented a **token-based authentication system** with:
- Bearer tokens for API authentication
- Role-based access control (ADMIN, MEMBER, VIEWER)
- Optional signature verification for enhanced security

### Token Types

1. **User Tokens** - For human users accessing the API
2. **Agent Tokens** - For AI agents to perform tasks autonomously

### Role Permissions

| Role | Create | Read | Update | Delete | Admin |
|------|--------|------|--------|--------|-------|
| ADMIN | ✓ | ✓ | ✓ | ✓ | ✓ |
| MEMBER | Own only | ✓ | Own only | Own only | ✗ |
| VIEWER | ✗ | ✓ | ✗ | ✗ | ✗ |

## Decision Details

**Token authentication benefits:**
- Stateless (no session storage needed)
- Easy to revoke by deleting token
- Scalable across multiple instances
- Support for multiple tokens per user

**Signature verification:**
- Optional additional security layer
- Prevents replay attacks
- Validates request integrity

## Consequences

### Positive
- Stateless authentication scales well
- Easy token management (create, revoke)
- Supports API access for integrations
- Role-based permissions provide security

### Negative
- Token storage and management required
- Refresh token flow not implemented
- Password reset requires CLI tool

## References

- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
