# Permission Matrix

Open-Kanban 的权限决策由四层结构组成：全局角色、看板所有者、看板权限、列权限。本文记录每一层的语义、互相之间的优先级，以及常见场景下系统应该给出的最终判断。

> 本文档与后端 `internal/handlers/permission_helper.go` 中的 `checkBoardAccess` / `checkColumnAccessWithBoardFallback` / `loadBoardAccess` 等函数保持一致；任何修改请同步更新本文与单测。

## 1. 角色与访问级别

### 1.1 全局角色（`users.role`）

| 角色    | 含义                                                                |
| ------- | ------------------------------------------------------------------- |
| ADMIN   | 系统级超级管理员，可访问任何资源、修改任何权限、开关任何看板 / 用户。 |
| MEMBER  | 普通成员。能否访问某个看板 / 列取决于该资源上的显式权限授权。        |
| VIEWER  | 只读成员。只能消费资源而不能修改，且 handler 层会拦截所有写操作。   |

### 1.2 资源访问级别（`board_permissions.access` / `column_permissions.access`）

```
READ  = 1
WRITE = 2
ADMIN = 3
```

数值越大权限越高。请求所需的访问级别必须 ≤ 用户在该资源上的有效访问级别，否则拒绝。

## 2. 角色 × 操作矩阵

下表覆盖系统中所有受权限影响的操作。✅ 表示全局角色即可执行；✗ 表示禁止；⛔ 表示需要对应资源上的访问级别满足一定阈值。

| 操作                                  | ADMIN | MEMBER                | VIEWER |
| ------------------------------------- | :---: | :-------------------: | :----: |
| 查看公开看板 (`GET /boards`)          | ✅    | ✅                    | ✅     |
| 创建看板                              | ✅    | ✅                    | ✗     |
| 删除看板                              | ✅    | ⛔ ADMIN on board      | ✗     |
| 创建任务                              | ✅    | ⛔ WRITE on board/column | ✗     |
| 编辑他人任务                          | ✅    | ⛔ ADMIN on column     | ✗     |
| 编辑自己创建的任务                    | ✅    | ✅                    | ✗     |
| 删除任务                              | ✅    | ⛔ WRITE on column     | ✗     |
| 添加评论                              | ✅    | ⛔ READ on board/column | ✗     |
| 给看板授权（`POST /permissions`）     | ✅    | ⛔ owner of board      | ✗     |
| 给列授权（`POST /permissions/columns`）| ✅   | ✗                     | ✗     |
| 创建 / 删除用户 / 智能体              | ✅    | ✗                     | ✗     |
| 修改他人角色 / 启用 / 停用            | ✅    | ✗                     | ✗     |
| 修改自己的昵称 / 头像                 | ✅    | ✅                    | ✅     |
| 修改系统配置（注册开关等）            | ✅    | ✗                     | ✗     |

## 3. 权限继承顺序

```
┌──────────────────────────────────────────────────┐
│ 1. 全局 ADMIN 角色                                │
│    → 命中即放行，不查询资源授权                    │
├──────────────────────────────────────────────────┤
│ 2. 看板所有者（owner_agent_id == user_id）         │
│    → 该行记录存在且 owner_agent_id 等于 user_id 时 │
│      视为该看板的 ADMIN                            │
├──────────────────────────────────────────────────┤
│ 3. 看板权限（board_permissions.access）           │
│    → 对应记录存在时使用该 access                   │
├──────────────────────────────────────────────────┤
│ 4. 列权限（column_permissions.access）             │
│    → 命中列记录则使用列级别 access                 │
│    → 未命中列记录时回退到第 3 步看板权限            │
└──────────────────────────────────────────────────┘
```

每一层都比下一层优先：

1. **全局 ADMIN**：遇到 `users.role == 'ADMIN'` 立即放行，不再读 `board_permissions` / `column_permissions`。
2. **看板所有者**：当 `board_permissions` 中目标行的 `owner_agent_id` 与 `user_id` 相同时，`loadBoardAccess` 返回 `"ADMIN"`。该返回值会写入缓存，后续检查直接命中。
3. **看板权限**：读取 `board_permissions.access`，若为空则视为无授权。
4. **列权限**：读取 `column_permissions.access`。**列权限一旦存在即覆盖看板权限**，不论大小（这是有意为之的设计：列级授权是看板所有者做出的更精细决定）。

> 校验逻辑位于 `checkColumnAccessWithBoardFallback`：先看列记录，存在就以列记录为准；没有列记录再 fallback 到所在看板的记录。

## 4. 常见场景示例

### 4.1 普通成员读写自己创建的任务

| 层级               | 值                                                          |
| ------------------ | ----------------------------------------------------------- |
| 全局角色           | MEMBER                                                      |
| 该任务所属看板权限 | 无                                                          |
| 该任务所属列权限   | 无                                                          |
| 任务 `created_by`  | user_id                                                     |
| 决策               | ✅ `canModifyTask` 允许（task 创建者永远是 owner-writer）     |

### 4.2 VIEWER 被加入看板做只读评审

| 层级             | 值                                       |
| ---------------- | ---------------------------------------- |
| 全局角色         | VIEWER                                   |
| 看板权限         | READ                                     |
| 决策             | ✅ 可读取；handler 层 `requireNonViewer` 拦截写操作 |

### 4.3 MEMBER 拥有某看板，但需要给另一个列再加 ADMIN

```
全局角色         = MEMBER
bp-user-board1   = (存在, owner_agent_id=user, access=READ)   → 所有者短路 → ADMIN
cp-user-columnX  = (不存在)
```

→ 用户在 board1 上是 ADMIN，可在 board 内任意列写任务。
→ 想授权别人在 columnX 上 ADMIN，需要调用 `POST /api/permissions/columns`，仅 ADMIN 可调用。

### 4.4 看板所有者撤销自己的授权

`DeletePermission` 会主动校验目标行的 `owner_agent_id == targetUserID`：

- 若是所有者本人 → 返回 403 `Cannot revoke the board owner's permission`，防止看板失去唯一所有者。
- 若不是所有者 → 删除成功并刷新权限缓存。

### 4.5 列权限高于看板权限

```
bp-user-board1   = (存在, access=READ)
cp-user-columnA  = (存在, access=ADMIN)
```

→ 用户对 columnA 实际权限 = ADMIN（列记录存在即生效，不是 max(READ, ADMIN)）。
→ 用户对 board1 其他列仍为 READ（无列记录，回退到看板 READ）。

### 4.6 最后一个管理员不能被降级 / 停用 / 删除

`UpdateUser` / `SetUserEnabled` / `DeleteAgent` 都会在写库前调用 `IsLastAdmin(db, targetUserID)`：

- 当 `targetUserID` 是唯一的 `enabled=1` 且 `role=ADMIN` 的用户时返回 true。
- true 时拒绝操作并返回 400（"Cannot demote / disable / delete the last admin"）。

### 4.7 权限变更立即生效

权限相关的写操作（`SetPermission`、`DeletePermission`、`SetColumnPermission`、`DeleteColumnPermission`、`UpdateUser`、`SetUserEnabled`）都会：

1. 删除该用户所有 token 的缓存条目（`tokenCache.DeleteByUserID`）。
2. 删除该用户所有权限缓存条目（`permissionCache.InvalidateUser`）。
3. 删除该资源相关的所有权限缓存条目（`permissionCache.InvalidateResource`）。

下一次请求即读取最新数据库状态，不存在「需要重新登录才能看到新权限」的滞后窗口。

## 5. 缓存语义

| 缓存               | Key                  | 失效时机                                              |
| ------------------ | -------------------- | ----------------------------------------------------- |
| `tokenCache`       | token key            | 用户角色 / 启用状态 / 权限变更时调用 `DeleteByUserID` |
| `permissionCache`  | `user_id\x00resource_id` | 用户权限变更时 `InvalidateUser` + `InvalidateResource` |

默认 TTL 为 5 分钟（`permissionCacheDuration` / `tokenCacheDuration`），但所有写入路径都主动失效相关条目，所以实际生效延迟在毫秒级。

## 6. 测试与覆盖

- 集成测试：`backend/internal/handlers/permission_integration_test.go`
  - `TestPermissionMatrix_AllRolesAllAccessLevels` — 全角色 × 全资源 × 全操作枚举
  - `TestPermissionCascade_ColumnOverridesBoard` — 列权限覆盖看板权限
  - `TestPermissionCascade_BoardFallback` — 列无权限时回落看板权限
  - `TestPermissionInheritance_OwnerInheritsAll` — 所有者继承 ADMIN
  - `TestPermissionChange_TakesEffectImmediately` — 权限变更立即生效（缓存失效）
  - `TestLastAdmin_CannotBeDemoted` — 最后一个 admin 不可被降级
  - `TestLastAdmin_CannotBeDisabled` — 最后一个 admin 不可被停用
  - `TestPermissionRevoke_CleansUpActiveSessions` — 撤销授权后清理活动会话
- 单元测试：`permission_helper_test.go` / `permission_cache_test.go` / `board_owner_test.go`
- 覆盖率目标：权限相关代码行覆盖 ≥ 85%（CI 中 `go tool cover -func` 校验）
