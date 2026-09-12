# Open Kanban CLI - 项目规划

> 创建日期: 2026-09-12
> 父任务: s-1061
> 目标: 构建一个与 MCP server 功能完全等价的命令行客户端，并支持 OAuth 2.1 动态注册（无需手动配置 token）

---

## 1. 项目概述

### 1.1 目标

开发 `open-kanban-cli` —— 一个独立的 npm 包，提供与 `open-kanban-mcp` 功能对等的命令行界面。
任何 MCP 工具能做的事情，CLI 都能做；不同的是输出格式为人/脚本友好的文本/JSON 而非 JSON-RPC。

### 1.2 关键需求

| 需求 | 说明 |
|------|------|
| 全量 MCP 功能 | 镜像 `mcp-server/tools/` 下全部 31 个工具 |
| 动态注册 | 复用 MCP 的 OAuth 2.1 device flow，**不**支持 `KANBAN_CLI_TOKEN` 之外的静态 token 配置 |
| 零配置上手 | 首次运行 `kanban auth login` 即可完成 DCR + device flow + token 持久化 |
| 双输出格式 | 默认人类可读表格（`--output table`），可切 JSON（`--output json`）便于脚本管道 |
| 可选交互模式 | 提供 `kanban shell` 进入 REPL，方便人工探索 |

### 1.3 技术栈

| 项 | 选择 | 理由 |
|----|------|------|
| 语言 | TypeScript | 复用 mcp-server 的 OAuth client 代码 |
| 运行时 | Node.js >= 18 | 与 mcp-server 一致，支持 `fetch`、`crypto.subtle` |
| 框架 | Commander.js | 轻量、声明式、广泛使用 |
| 输出 | chalk + cli-table3 | 颜色与表格 |
| 提示 | @inquirer/prompts | device flow 等待、确认 |
| 测试 | Vitest | 与 mcp-server 一致 |
| 打包 | tsc + shebang | 与 mcp-server 一致 |

---

## 2. 目录结构（建议）

```
cli/
├── package.json
├── tsconfig.json
├── README.md
├── index.ts                # CLI 入口
├── src/
│   ├── auth/
│   │   ├── client.ts       # 从 mcp-server 移植 OAuthClient
│   │   ├── device-flow.ts
│   │   ├── discovery.ts
│   │   ├── dcr.ts
│   │   ├── token-store.ts
│   │   └── types.ts
│   ├── http/
│   │   └── client.ts       # apiGet/apiPost/apiPut/apiDelete + 自动 refresh
│   ├── commands/
│   │   ├── auth.ts
│   │   ├── status.ts
│   │   ├── dashboard.ts
│   │   ├── boards.ts
│   │   ├── columns.ts
│   │   ├── tasks.ts
│   │   ├── drafts.ts
│   │   ├── archived.ts
│   │   ├── comments.ts
│   │   ├── subtasks.ts
│   │   ├── mine.ts
│   │   ├── workspace.ts
│   │   └── shell.ts
│   ├── output/
│   │   ├── format.ts       # json/table 渲染
│   │   └── color.ts
│   └── config.ts           # CLI 全局配置（API URL、输出格式）
└── tools/                  # (与 mcp-server 共用 src/auth，符号链接或私有复制)
```

---

## 3. 命令清单（覆盖全部 31 个 MCP 工具）

| CLI 命令 | 对应 MCP 工具 | 优先级 |
|----------|----------------|--------|
| `kanban status` | `get_status` | high |
| `kanban dashboard` | `get_dashboard_stats` | high |
| `kanban boards list` | `list_boards` | high |
| `kanban boards get <id>` | `get_board` | high |
| `kanban columns list [--board <id>]` | `list_columns` | high |
| `kanban columns get <id>` | `get_column` | high |
| `kanban tasks list [filters...]` | `list_tasks` | high |
| `kanban tasks get <id>` | `get_task` | high |
| `kanban tasks create ...` | `create_task` | high |
| `kanban tasks update <id> ...` | `update_task` | high |
| `kanban tasks delete <id>` | `delete_task` | high |
| `kanban tasks complete <id>` | `complete_task` | high |
| `kanban tasks move <id> --status <s>` | (基于 update_task) | high |
| `kanban tasks batch create <file>` | `batch_create_tasks` | medium |
| `kanban tasks batch update ...` | `batch_update_tasks` | medium |
| `kanban tasks batch delete <ids...>` | `batch_delete_tasks` | medium |
| `kanban drafts list` | `list_drafts` | medium |
| `kanban drafts publish <id>` | `publish_task` | medium |
| `kanban drafts unpublish <id>` | `publish_task(published=false)` | medium |
| `kanban archived list` | `list_archived_tasks` | medium |
| `kanban archived archive <id>` | `archive_task` | medium |
| `kanban archived restore <id>` | `archive_task(archived=false)` | medium |
| `kanban comments add <taskId> --body <text>` | `add_comment` | medium |
| `kanban comments list <taskId>` | `list_comments` | medium |
| `kanban subtasks list <taskId>` | `list_subtasks` | medium |
| `kanban subtasks create <taskId> --title <t>` | `create_subtask` | medium |
| `kanban subtasks update <id> ...` | `update_subtask` | medium |
| `kanban subtasks delete <id>` | `delete_subtask` | medium |
| `kanban mine` | `list_my_tasks` | medium |
| `kanban workspace upload <file>` | `upload_file` | medium |
| `kanban workspace batch-upload <files...>` | `batch_upload_files` | medium |
| `kanban workspace list` | `list_workspace_files` | medium |
| `kanban workspace read <id>` | `read_workspace_file` | medium |
| `kanban workspace delete <id>` | `delete_workspace_file` | medium |
| `kanban workspace stats` | `workspace_stats` | medium |
| `kanban auth login` | (device flow 触发器) | high |
| `kanban auth status` | (本地) | high |
| `kanban auth logout` | (本地) | high |
| `kanban shell` | (REPL) | low |
| `kanban version` | (本地) | low |
| `kanban help` | (本地) | low |

---

## 4. 动态注册（OAuth 2.1 device flow）

参考 `mcp-server/src/auth/` 已实现的流程：

1. **discovery**: `GET {api}/.well-known/oauth-authorization-server`
2. **DCR**: `POST {api}/oauth/register`（public client, client_name=`open-kanban-cli`）
3. **device code**: `POST {api}/oauth/device/code`
4. **prompt**: stdout 输出 `Visit: ...  Enter code: ...`，等待用户在浏览器授权
5. **poll**: 轮询 `/oauth/token` 直到成功
6. **persist**: 加密写入 `$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode 0600)
7. **refresh**: 在 token 过期前自动 refresh

> **关键差异 vs MCP**: MCP 是常驻进程，每次调用 API 时按需 refresh；CLI 是短期进程，每次调用都需要从磁盘加载 credentials，必要时先 refresh 一次再请求。

### Token 存储路径

| 平台 | 路径 |
|------|------|
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/kanban-cli/credentials-<apiHost>.json` |
| macOS | 同上 |
| Windows | `%APPDATA%\kanban-cli\credentials-<apiHost>.json` |

### 多账号支持

文件名包含 api host，保证不同部署地址互不冲突。若同一 host 需要多账号，CLI 提供 `KANBAN_CLI_PROFILE` 环境变量切换 profile：

```
$HOME/.config/kanban-cli/
├── credentials-localhost.json          # 默认
├── credentials-staging.example.com.json
└── credentials-prod.example.com.json
```

---

## 5. 输出格式

### 5.1 默认（人类可读）

```
$ kanban tasks list --status todo --priority high
ID      TITLE                          PRIORITY  ASSIGNEE   UPDATED
s-1061  创建自项目: Cli                high      opencoder  5m ago
s-1057  [PM修复] 修复P0级无效Tailwind   high      OpenClow   2d ago
```

### 5.2 JSON（脚本友好）

```
$ kanban tasks list --status todo --priority high --output json
[
  {"id":"s-1061","title":"创建自项目: Cli","priority":"high",...},
  ...
]
```

### 5.3 字段选择

支持 `--fields id,title` 与 MCP 的 `lightweight/fields` 参数对齐。

---

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| 未登录 | 提示 `Run 'kanban auth login' first`，退出码 2 |
| API 401 | 自动 refresh 后重试一次；再失败提示重新登录 |
| API 404 | 友好提示 `Not found: <resource>`，退出码 4 |
| API 5xx | 打印 `Server error: <status> <body>`，退出码 5 |
| 网络错误 | 打印 `Network error: <msg>`，退出码 6 |

退出码与 POSIX 习惯一致，便于 shell 脚本使用。

---

## 7. 实施步骤（按优先级与依赖排序）

### Phase 1 — 基础（high 优先级，必须先做）

1. **s-c1** 初始化 `cli/` 包结构（package.json、tsconfig、vitest、目录骨架）
2. **s-c2** 从 mcp-server 移植 OAuth 2.1 client 到 `cli/src/auth/`
3. **s-c3** 实现 HTTP client（`apiGet/Post/Put/Delete` + 自动 refresh + 错误映射）
4. **s-c4** 实现 `kanban auth login / status / logout` 命令
5. **s-c5** 实现 `kanban status` 与 `kanban dashboard`
6. **s-c6** 实现 `kanban boards list/get` 与 `kanban columns list/get`
7. **s-c7** 实现 `kanban tasks list/get/create/update/delete/complete/move`（单任务核心）
8. **s-c8** 为 Phase 1 编写单元测试 + 集成测试（用 vi.mock fetch）

### Phase 2 — 全功能（medium 优先级）

9. **s-c9** 实现批量任务操作（batch create/update/delete）
10. **s-c10** 实现 drafts/publish/archived 命令
11. **s-c11** 实现 comments 命令
12. **s-c12** 实现 subtasks 命令
13. **s-c13** 实现 `kanban mine`
14. **s-c14** 实现 workspace 上传/列表/读/删除/统计命令
15. **s-c15** 输出格式打磨（表格、颜色、字段选择、空值处理）

### Phase 3 — 体验优化（low 优先级）

16. **s-c16** 实现 `kanban shell` REPL（inquirer + history + 命令补全）
17. **s-c17** 实现 config 管理（`kanban config get/set`，环境变量覆盖）
18. **s-c18** 添加 shell 补全（`kanban completion bash|zsh|fish`）
19. **s-c19** README + 中文使用文档 + manpage
20. **s-c20** npm 发布流水线 + CI release workflow

---

## 8. 与 MCP server 的代码复用策略

### 选项 A：符号链接 `src/auth/`（开发期）

在 `cli/src/auth/` 软链到 `../mcp-server/src/auth/`。优点：零拷贝；缺点：部署到 npm 时需随包复制。

### 选项 B：把 `src/auth/` 抽成独立 workspace package（推荐）

```
packages/
├── auth-client/   # 通用 OAuth 2.1 client
├── mcp-server/    # 现 mcp-server
└── cli/           # 新 cli
```

通过 pnpm workspace 共享。优点：DRY、MCP/CLI 一致；缺点：需重构 mcp-server 引入 workspace。

> **建议**: 短期采用选项 A（符号链接 + 构建期拷贝），中长期重构为选项 B。本规划任务序列按选项 A 落地。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| OAuth 设备码超时 | 用户必须重跑 login | 提供 `--timeout 600` 延长，并给出倒计时 |
| 多账号易混淆 | 用户选错环境 | `--profile` 强制显式选择；`kanban auth status` 醒目展示当前 host |
| 大表格排版差 | 终端窄时难看 | 默认输出检测 TTY，自动降级为列表；提供 `--no-table` |
| 终端无颜色 | CI 报错信息难看 | 检测 `NO_COLOR`/`--no-color` 时跳过 ANSI |
| 与 MCP 行为不一致 | 用户混淆 | 在 README 标注「CLI is to MCP what curl is to Postman」 |

---

## 10. 验收标准（Definition of Done）

- [ ] `kanban auth login` 在干净的容器内可完成 device flow 并落盘
- [ ] `kanban tasks list` 与 `mcp-server` 的 `list_tasks` 在相同条件下返回一致结果
- [ ] 31 个 MCP 工具全部有对应 CLI 命令，行为等价
- [ ] `--output json` 输出可直接被 `jq` 处理
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] README 包含安装、快速开始、命令清单、退出码说明
- [ ] CI 通过（lint + test + build）
- [ ] `npm run build` 产物 `dist/index.js` 带 shebang，`npx open-kanban-cli --help` 可用

---

## 11. 时间估算（仅供参考）

| Phase | 任务 | 预估 |
|-------|------|------|
| 1 | s-c1 ~ s-c8 | 5-7 工作日 |
| 2 | s-c9 ~ s-c15 | 4-6 工作日 |
| 3 | s-c16 ~ s-c20 | 3-4 工作日 |
| 总计 | | 约 2-3 周 |

---

## 12. 相关链接

- 父任务: `s-1061` 创建自项目: Cli
- 兄弟任务: `s-1060` 调研开发一个 runner cli（与 CLI 部分功能重叠，需后续合并讨论）
- MCP server 源码: `mcp-server/`
- OAuth 2.1 实现: `mcp-server/src/auth/`
- 后端 API: `backend/`
