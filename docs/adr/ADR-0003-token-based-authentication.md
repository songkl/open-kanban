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

## Permission Model Evolution

初始版本（[1.0.0](#)）仅使用 `users.role`（ADMIN / MEMBER / VIEWER）做粗粒度的访问控制。随着产品对协作场景的支持（一个看板里既有产品、也有开发、还要给客户只读评审），单纯的全局角色已经无法满足细粒度需求，因此后续版本演进如下：

### v1.1 — 看板级权限

引入 `board_permissions` 表与 `READ` / `WRITE` / `ADMIN` 三级访问级别：

- 看板所有者自动获得 ADMIN（通过 `owner_agent_id` 字段标记创建者）。
- MEMBER / VIEWER 必须通过 `POST /api/v1/auth/permissions` 被显式授权才能访问。
- 全局 ADMIN 仍然跳过查询，所有资源均可访问。

### v1.2 — 列级权限

部分敏感列（如发布前的草稿列、客户不能看的内部列）需要更细粒度的控制，于是新增 `column_permissions` 表：

- 列权限一旦存在即覆盖同看板上的看板权限，不论大小（更精细的授权优先于粗粒度授权）。
- 列无权限记录时回退到看板权限。
- 授予列权限需要 ADMIN 角色（不允许普通成员自助申请）。

### v1.3 — 缓存与即时生效

权限检查每次都查 DB 在高并发下会成为瓶颈，因此引入 `permissionCache`：

- `(user_id, board_id | column_id)` → `access`，默认 TTL 5 分钟。
- 所有权限写入路径（`SetPermission` / `DeletePermission` / `SetColumnPermission` / `DeleteColumnPermission` / `UpdateUser` / `SetUserEnabled`）都会主动调用 `tokenCache.DeleteByUserID` + `permissionCache.InvalidateUser` + `permissionCache.InvalidateResource`，保证权限变更在下一个请求即可见。
- 集成测试 `permission_integration_test.go::TestPermissionChange_TakesEffectImmediately` 与 `TestPermissionRevoke_CleansUpActiveSessions` 锁定该契约。

### v1.4 — 最后管理员保护

新增 `IsLastAdmin(db, targetUserID)`：

- 在 `UpdateUser` / `SetUserEnabled` / `DeleteAgent` 三个 handler 中调用，防止「最后一个 enabled ADMIN 被降级 / 停用 / 删除」导致系统失去管理入口。
- 该守卫通过 `backend/internal/handlers/permission_integration_test.go::TestLastAdmin_CannotBeDemoted` 与 `TestLastAdmin_CannotBeDisabled` 锁定。

### 当前模型

| 层级        | 数据来源                       | 优先级 |
| ----------- | ------------------------------ | :----: |
| 全局角色    | `users.role`                   | 1（最高）|
| 看板所有者  | `board_permissions.owner_agent_id` | 2    |
| 看板权限    | `board_permissions.access`     | 3      |
| 列权限      | `column_permissions.access`     | 4（最低，但存在即生效）|

完整矩阵、场景示例、测试入口见 `docs/PERMISSION_MATRIX.md`。

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
