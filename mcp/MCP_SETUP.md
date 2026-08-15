# Open Kanban MCP 集成指南 (OAuth 2.1)

> Open Kanban v2.0 起,MCP 服务器与看板后端的授权统一走 OAuth 2.1 设备授权流程(RFC 8628)。
> 旧的 `KANBAN_MCP_TOKEN` 仍可使用,但 **推荐迁移到 OAuth 流程**,自动续期、无需手动复制 token。

## 功能概览

- 📋 **任务管理**:创建、编辑、删除、移动任务
- 📝 **子任务**:添加子任务、标记完成
- 💬 **评论**:任务讨论和沟通
- 🏷️ **元信息**:支持自定义键值对
- 📁 **看板管理**:多看板支持
- 🔄 **实时同步**:通过 WebSocket 自动刷新
- 🔐 **OAuth 2.1**:无 token 复制、自动续期、设备授权流程

## MCP Server 集成

### 推荐:零配置(自动 OAuth)

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "open-kanban-mcp@latest"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

首次启动时,MCP 进程会:
1. 调用 `GET /.well-known/oauth-authorization-server` 发现端点
2. 调用 `POST /oauth/register` 进行动态客户端注册(无需在看板后台手动创建)
3. 调用 `POST /oauth/device/code` 申请设备码
4. 在终端打印用户码与验证 URL,例如:

```
[kanban-mcp] OAuth authorization required
  Visit: http://localhost:8080/oauth/device
  Enter code: HSXL-KQPR
  Waiting for approval...
```

5. 用户在浏览器打开链接、输入用户码、批准授权
6. MCP 进程自动轮询 `POST /oauth/token`,获得 `access_token` + `refresh_token`
7. 凭据加密存储在 `~/.config/kanban-mcp/credentials-<api>.json`
8. 后续调用自动附带 `Authorization: Bearer <jwt>`,access token 即将过期时用 refresh token 静默续期

### 旧版兼容(不推荐)

仍可使用 `KANBAN_MCP_TOKEN` 环境变量手动注入 64 字符 hex token,适用于 CI/容器化等场景。
当 OAuth 流程不可用时,助手会回落到此模式。

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "open-kanban-mcp@latest"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080",
        "KANBAN_MCP_TOKEN": "4baf8236..."
      }
    }
  }
}
```

## OAuth 端点一览

| 端点 | 用途 |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 元数据 |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 8707 资源元数据 |
| `GET /.well-known/jwks.json` | JWT 公钥 (RFC 7517) |
| `POST /oauth/register` | 动态客户端注册 (RFC 7591) |
| `POST /oauth/device/code` | 申请设备码 (RFC 8628) |
| `POST /oauth/token` | 兑换/刷新 token(支持 `device_code`、`refresh_token`、`client_credentials`、`authorization_code`) |
| `POST /oauth/revoke` | 撤销 token (RFC 7009) |
| `POST /oauth/introspect` | 自省 token (RFC 7662) |
| `POST /oauth/device/approve` | 用户在浏览器侧批准设备码(需登录) |
| `GET /oauth/device/lookup?user_code=...` | 公开读取待审批设备码的元数据 |

## Scope

| Scope | 含义 |
|---|---|
| `kanban:read` | 只读看板/任务/子任务/评论 |
| `tasks:write` | 创建/更新任务 |
| `comments:write` | 发评论 |
| `boards:admin` | 管理看板、列 |
| `agents:manage` | 创建/重置 agent |

默认 MCP 客户端请求 `kanban:read tasks:write comments:write`。

## 设置中心(OAuth 选项)

管理员可在 **设置 → OAuth 2.1 → Settings** 调整:

- `oauth_enabled`:总开关,默认开启
- `oauth_allow_dynamic_client_registration`:动态注册开关
- `oauth_require_pkce`:authorization_code 流是否强制 PKCE
- `oauth_access_token_ttl_seconds`:access token 寿命(默认 3600 秒)
- `oauth_refresh_token_ttl_seconds`:refresh token 寿命(默认 30 天)
- `oauth_device_code_ttl_seconds`:设备码寿命(默认 600 秒)
- `oauth_device_poll_interval_seconds`:轮询最小间隔(默认 5 秒)
- `oauth_authorization_code_ttl_seconds`:授权码寿命(默认 120 秒)

在 **设置 → OAuth 2.1 → Apps** 中,管理员可以查看/删除已注册的 OAuth 应用。
在 **设置 → OAuth 2.1 → Permissions** 中,每个用户可以查看/撤销自己对各应用的授权。

## 撤销已注册的 MCP 客户端

MCP 进程对应的注册应用会出现在 **设置 → OAuth 2.1 → Apps**。要强制下线某个 MCP 实例:
1. 删除对应应用 → 自动撤销该 `client_id` 下的所有 refresh token
2. MCP 进程下次启动时会重新进行设备授权流程