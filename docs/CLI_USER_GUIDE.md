# Kanban CLI — 使用指南 / User Guide

> **新手从这里开始 / Start here if you're new.**
> For the technical flag-by-flag reference, see [`CLI_COMMANDS.md`](./CLI_COMMANDS.md).
> For end-to-end onboarding / troubleshooting, see [`cli/README.md`](../cli/README.md).

`kanban` 是 Open Kanban 看板的命令行客户端 (command-line client).
它让你在终端里读写任务、上传文件、跑自动化 agent —— 同一个 OAuth 会话同时被 CLI、MCP server 和 Web UI 共享。

This guide walks you through everything from your first login to advanced
automation, with runnable examples at every step. 中文段落解释了**为什么**
这么做;English snippets give you the exact commands to copy.

---

## 目录 / Table of contents

1. [安装 / Installation](#1-安装--installation)
2. [第一次登录 / First login](#2-第一次登录--first-login)
   - [2.1 给自动化 / Runner 绑定一个 Agent 身份](#21-给自动化--runner-绑定一个-agent-身份--bind-the-cli-to-an-agent-identity)
   - [2.2 Device-flow Agent 选择 / Pick which identity the device flow binds to](#22-device-flow-agent-选择--pick-which-identity-the-device-flow-binds-to)
3. [看懂看板 / Reading the board](#3-看懂看板--reading-the-board)
4. [创建并流转任务 / Creating and moving tasks](#4-创建并流转任务--creating-and-moving-tasks)
5. [评论与子任务 / Comments & subtasks](#5-评论与子任务--comments--subtasks)
6. [草稿、归档、批量操作 / Drafts, archive, batch operations](#6-草稿归档批量操作--drafts-archive-batch-operations)
7. [配置文件 / Configuration files](#7-配置文件--configuration-files)
8. [脚本与管道 / Shell pipelines & scripting](#8-脚本与管道--shell-pipelines--scripting)
9. [退出码与错误处理 / Exit codes & errors](#9-退出码与错误处理--exit-codes--errors)
10. [Runner: 让 CLI 帮你跑 agent / Runner loop](#10-runner-让-cli-帮你跑-agent--runner-loop)
11. [常见问答 / FAQ](#11-常见问答--faq)

---

## 1. 安装 / Installation

CLI is a single Node.js (>= 18) binary. Pick the install flavour that fits:

| 场景 / Scenario | 命令 / Command |
|---|---|
| **全局 npm (推荐)** / Global npm (recommended) | `npm install -g open-kanban-cli` |
| **不安装,直接跑** / No install, run on demand | `npx -y open-kanban-cli --help` |
| **从源码构建** / Build from source | `cd cli && npm install && npm run build && node ./dist/index.js --help` |

After installing, verify the binary is reachable and the version looks sane:

```bash
kanban --version       # should print 0.1.0 (or newer)
node --version         # must be v18.x or newer
which kanban           # should resolve to a path
```

> **Homebrew tap:** planned but not yet published. Track
> [the GitHub repo](https://github.com/songkl/open-kanban) for the tap formula.

---

## 2. 第一次登录 / First login

CLI 使用 OAuth 2.1 的 **device authorization grant** —— 你不需要把密码敲进终端,只需要在浏览器里点一次确认。

The CLI uses OAuth 2.1's device authorization grant, so your password never
touches the terminal. The flow is:

1. CLI 自动注册一个公共 OAuth 客户端 (`POST /oauth/register`)
2. CLI 向 server 请求一个 `device_code` + 用户码 (`POST /oauth/device/code`)
3. 终端打印**验证 URL** 和**用户码** 到 stderr
4. 你在浏览器里打开 URL,输入用户码,点确认
5. CLI 后台轮询 `/oauth/token`,拿到 token 后加密落盘

```bash
# Step 1 — point at your Kanban server
export KANBAN_API_URL="https://kanban.example.com"

# Step 2 — start the device flow
kanban auth login
#   stderr output:
#     Open Kanban authorization required
#       Visit:  https://kanban.example.com/oauth/device
#       Code:   HSXL-KQPR
#       Scope:  kanban:read tasks:write
#       Waiting for approval (expires in 600s)...
```

You have **600 seconds** to approve in the browser. If the timer runs out,
the CLI exits with code `3` — just rerun `kanban auth login`.

After approval, the CLI stores the issued tokens at:

```
$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json    # mode 0600
```

(`<api>` is the API URL slugged into a filename-safe string, so each
server you log in to gets its own credentials file.)

确认登录成功 / Verify the session:

```bash
kanban auth status    # prints: profile, host, scope, token expiry
kanban auth whoami    # calls GET /api/v1/users/me and prints your account
```

登出 / Sign out (idempotent — safe to run even if you're not logged in):

```bash
kanban auth logout
```

> **Tip / 小提示:** 每换一个 `--api-url`,CLI 就会创建一份新的凭据文件。
> 所以在同一台机器上可以同时登录 `work` 和 `personal` 两个看板,
>互不干扰。
>
> Switching `--api-url` produces a fresh credentials file. So you can be
> logged in to `work` and `personal` boards at the same time on the same
> machine — they live in separate files.

### 2.1 给自动化 / Runner 绑定一个 Agent 身份 / Bind the CLI to an Agent identity

`kanban auth login` 走的是 OAuth device flow,最终拿到的 access token
会绑定到那个点"批准"的人类用户。对人来说没问题,但 CI / watcher /
`kanban run` 这种无人值守的场景就有两个副作用:

1. 每条评论 / 任务都会记成某个 admin 的操作,审计日志被噪声淹没。
2. `kanban mine` 的 agent-type 过滤失效 —— 因为 token 主体是人类,
   `/api/v1/users/me` 返回的 `type` 也是 `HUMAN`。

`kanban auth agent` 这一组命令就是为此设计的 —— 它会让 CLI 持有一个
**Agent 类型的 API token**,而不是某个 admin 的 OAuth 会话。

```
# 一次性:用 admin 账号登录,然后创建一个 Agent
kanban auth login
kanban auth agent create ci-runner --role ADMIN
#   ↳ 打印出一次性 API token(请立刻存进 secret manager)
#   ↳ 同时写进 ~/.config/kanban-cli/credentials-<api>.json

# 之后 `kanban status` / `whoami` / `mine` / `run` 都以这个 Agent 身份运行
kanban auth status    # Identity: Agent (long-lived token)
kanban mine           # 看到所有 routed 给 ci-runner 的任务
```

如果你的 secret manager 已经存着现成的 Agent token(比如从 Web UI 的
Settings → Agents 复制出来),跳过 OAuth 直接 bind 即可:

```
# 三选一: --token / $KANBAN_AGENT_TOKEN / 交互式(密码回显关闭)
kanban auth agent bind --token agt_xxx...
KANBAN_AGENT_TOKEN=agt_xxx... kanban auth agent bind
kanban auth agent bind             # 提示输入,输入会被 mask
```

Admin 想清理时:

```
kanban auth agent list              # 查看所有 Agent
kanban auth agent delete ci-runner  # 删除
```

`auth agent bind` 会先调用 `GET /api/v1/users/me` 校验 token,
并拒绝绑定任何 `type='HUMAN'` 的会话 —— 防止误把 admin token 当成
Agent token 写进凭据文件。

### 2.2 Device-flow Agent 选择 / Pick which identity the device flow binds to

当你 (或你的同事) 在浏览器里打开 device-flow 授权页时,可能
会看到一个新的 **"Authorise as"** 下拉框 —— 这意味着 server 检测到
这次请求来自 CLI / MCP client (OAuth 客户端名匹配 `kanban-cli` /
`open-kanban-cli` / `*-cli`,或者 `grant_types` 包含 device-code)。

> When you (or your teammate) open the device-flow approval page for a
> CLI / MCP client, you'll see a new **"Authorise as"** selector. The
> server detected the request came from a CLI / MCP client (the OAuth
> client name matches `kanban-cli` / `open-kanban-cli` / `*-cli`, or
> its `grant_types` includes device-code), so it needs to know *which
> identity* to bind the issued JWT to.

下拉框里有两个选项 / The selector has two groups of options:

- **Myself (your account)** — 把 access token 绑到你自己的用户上 (`type='HUMAN'`)。
  适合临时手动跑 CLI 看看效果 / bind to your own human account.
- **An enabled Agent** — 列出的候选 Agent 来自 `GET /oauth/device/agents`,
  你 (作为授权人) 看到的就是 server 允许你代理的 Agent / every
  Agent the server lets you act as:
  - ADMIN 看到所有启用的 Agent。
  - MEMBER / VIEWER 只看到非 `ADMIN` 角色的 Agent。

如果 admin 在 Web UI 的 Settings → OAuth 里配了全局的
`oauth_device_agent_id`,那个 Agent 会被预先选中,并打上
**"(Server default agent)"** 标签 —— 你可以保留默认,也可以换成别的。

```text
Open Kanban authorization required
  Client:   open-kanban-cli
  Scope:    kanban:read tasks:write
  Authorise as: [ ci-runner (Server default agent) ▾ ]
      ▾ Myself (your account)
        ▾ ci-runner (Server default agent)
          opencode-bot
          watcher-prod
  [Deny]                                        [Approve]
```

选择会被 POST 到 `/oauth/device/approve`,作为 `agent_id`(或省略表示
"Myself")。server 会把 `oauth_device_codes.user_id`、`oauth_consents.user_id`
以及审计日志全部绑到你选的行上。最终 CLI 拿到的 JWT `sub` 就是这个 id,
`kanban run` 在 `/api/v1/runs/claim` 处的 `user_agent` 检查 (见
[`docs/CLI_COMMANDS.md` § Device-flow Agent selection](./CLI_COMMANDS.md#device-flow-agent-selection))
自然就过了。

> The chosen `agent_id` (or its absence, meaning "Myself") is POSTed
> to `/oauth/device/approve`. The server binds
> `oauth_device_codes.user_id`, `oauth_consents.user_id`, and the
> audit log to that row. The JWT the CLI eventually receives has
> `sub=<chosen id>`, so `kanban run`'s `user_agent` claim check at
> `/api/v1/runs/claim` keeps working unchanged.

#### 什么时候必须选 Agent / When you *must* pick an Agent

Settings → OAuth 里有个 **"Agent-only device flow"** 开关
(`oauth_device_require_agent_selection=1`)。打开之后:

- 任何用 HUMAN 身份点 Approve 都会被 server 拒绝 (`400 invalid_request`)。
- 唯一的例外是点 Approve 的人**自己**就是 `type='AGENT'` —— 那种情况下
  即使没显式选 Agent,server 也会把 token 绑回本人。

This is the boundary enforcement that backs the **"CLI runner is for
Agent use"** guarantee. Without it, `kanban run` would either refuse
every claim or, worse, allow a human to impersonate an Agent. Flip it
on once every consumer of the old flow has been migrated to the new
selector.

> **实操建议 / Practical advice:** 第一次升级 server 后,先把
> `oauth_device_require_agent_selection` 留作 `"0"`,让团队成员
> 跑一两次新的 device flow (页面会自动出现 Agent 选择器);当所有人都
> 验证过自己选到了正确的 Agent 之后,再把开关打开,从此封死"HUMAN
> 通过 device flow 跑 runner"的可能。

---

## 3. 看懂看板 / Reading the board

Before you write anything, take a look at what's already there.

### `kanban status` — API 探测 / API probe

不要求登录。返回 server 是否在线、延迟、看板块数。



## 3. 看懂看板 / Reading the board

Before you write anything, take a look at what's already there.

### `kanban status` — API 探测 / API probe

不要求登录。返回 server 是否在线、延迟、看板块数。

Does not require auth. Reports whether the server is reachable, latency,
and the count of non-deleted boards.

```bash
kanban status
# Kanban API   https://kanban.example.com
# Status       online
# Latency      42 ms
# Boards       3
# Timestamp    2026-09-12T04:00:00Z
#
#   ID                                   NAME
#   ──────────────────────────────────── ────────────────────────────
#   board-1                              Engineering
#   board-2                              Design
#   board-3                              Operations
```

### `kanban boards list` / `boards get` — 浏览看板 / Browse boards

```bash
kanban boards list                       # default projection
kanban boards list --fields id,name,columnCount
kanban boards get board-1
```

### `kanban columns list` / `columns get` — 浏览列 / Browse columns

```bash
kanban columns list                      # all columns on all boards
kanban columns list --board board-1 --positions 1,2,3
```

### `kanban dashboard` — 工作区统计 / Workspace stats

要求登录。返回总数、按状态 / 按优先级分布。

Auth required. Returns totals plus per-status / per-priority breakdowns.

```bash
kanban dashboard
```

### `kanban tasks list` — 列任务 / List tasks

`tasks list` 把过滤做在客户端,server 只返回原始 column 数据。

`tasks list` does filtering client-side; the server returns raw column
data. This means every filter is cheap to add and works on cached columns.

```bash
kanban tasks list                                  # every published task
kanban tasks list --status in_progress --priority high
kanban tasks list --assignee alice --since thisWeek
kanban tasks list --search "OAuth"                 # substring match on title/description
kanban tasks list --tag security                   # substring match on any meta value
kanban tasks list --board board-1 --column col-todo
```

> **注意 / Note:** `--column` and `--status` are mutually exclusive —
> if you pass both, the CLI exits with code `1` before any HTTP traffic.

### `kanban tasks get <id>` — 单个任务 / Fetch a single task

公开端点,无需登录。

Public endpoint — no auth required.

```bash
kanban tasks get task-123
```

---

## 4. 创建并流转任务 / Creating and moving tasks

### 4.1 创建任务 / Create

`tasks create` 是写操作,**要求登录**。至少要传 `--title`。

`tasks create` is a write — **auth required**. `--title` is mandatory.

```bash
# Simplest case — let the server pick the column
kanban tasks create --title "Ship docs"

# Pin a column explicitly
kanban tasks create --title "Refactor auth" \
    --column col-doing --priority high --assignee alice

# Use --status instead — CLI resolves to the matching column
kanban tasks create --title "Bug: 401 on refresh" \
    --board board-1 --status todo

# Create as a draft (not yet visible to other viewers)
kanban tasks create --title "Idea: dark mode" --no-publish

# Attach metadata (repeatable or comma-separated)
kanban tasks create --title "Write spec" \
    --meta tag=docs,sprint=q3 --meta reviewer=alice
```

> **解析规则 / Resolution rules:** explicit `--column` wins → then
> `--status` is resolved to a column by name within `--board` (or any
> board) → then the first column of `--board` → then the first column
> globally. See `CLI_COMMANDS.md` for the full chain.

### 4.2 流转任务 / Move tasks through the board

Two equivalent commands exist:

| 命令 / Command | 用途 / Purpose |
|---|---|
| `kanban tasks complete <id>` | 推进到**下一列** / Advance to the next column |
| `kanban tasks move <id> --status <s>` | 跳到任意列 / Jump to any column |

```bash
kanban tasks move task-123 --status in_progress   # explicit target
kanban tasks complete task-123                    # advance one column
```

### 4.3 更新任务 / Update

`tasks update` 一次能改任意字段组合。至少要传一个改动 flag。

`tasks update` accepts any subset of patch flags. At least one is required.

```bash
kanban tasks update task-123 --priority high
kanban tasks update task-123 --assignee bob --description "Updated notes"
kanban tasks update task-123 --meta tag=urgent
kanban tasks update task-123 --column col-review    # move + edit at once
```

### 4.4 删除任务 / Delete

```bash
kanban tasks delete task-123
# `--yes` is the default and accepted for symmetry with other commands
```

---

## 5. 评论与子任务 / Comments & subtasks

### 5.1 评论 / Comments

`comments add` 接受 `--body` 文本,或者 `--body -` 从 stdin 读。

`comments add` accepts either inline text or `--body -` to read from stdin.

```bash
# Inline
kanban comments add task-123 --body "LGTM, ship it"

# Multi-line from stdin
echo "Reviewed the OAuth flow.
Looks good overall. Suggest bumping the refresh interval." \
    | kanban comments add task-123 --body -

# Read body from a file
kanban comments add task-123 --body "$(cat review.md)"

# Override author (rare — server uses the authenticated user by default)
kanban comments add task-123 --body "Spoken on behalf of PM" --author pm-bot
```

`comments list` 按 `createdAt` 升序返回 (oldest first):

```bash
kanban comments list task-123
```

### 5.2 子任务 / Subtasks

```bash
kanban subtasks list task-123
kanban subtasks create task-123 --title "Set up DB migration"
kanban subtasks update subtask-456 --title "Set up DB schema" --completed
kanban subtasks update subtask-456 --no-completed      # mark incomplete
kanban subtasks delete subtask-456
```

> **字段约束 / Validation:** `--title` for create must be non-empty
> after trim. `--update` requires at least one of `--title / --completed /
> --no-completed`.

---

## 6. 草稿、归档、批量操作 / Drafts, archive, batch operations

### 6.1 草稿 / Drafts

`--no-publish` 让任务**保存为草稿**,不上看板。

Pass `--no-publish` to keep the task out of the public view:

```bash
kanban drafts list
kanban drafts list --board board-1
kanban drafts publish draft-123          # move draft → live
kanban drafts unpublish task-456         # move live → draft
```

### 6.2 归档 / Archive

归档是把任务从主列隐藏起来,而不是物理删除。

Archiving hides a task from active boards; the row stays around and can
be restored.

```bash
kanban archived list
kanban archived archive task-123
kanban archived restore task-123
```

### 6.3 批量操作 / Batch operations

`tasks batch` 把多个写操作打成一次 HTTP 请求,**要求登录**。

`tasks batch` bundles multiple writes into one HTTP request — **auth
required**.

```bash
# Create multiple tasks from repeated flags (positional alignment)
kanban tasks batch create \
    --title "Write spec"   --column col-todo  --priority high \
    --title "Implement X"  --column col-doing --priority medium

# Or load from a JSON / YAML file
kanban tasks batch create --file ./tasks.yaml

# Bulk-update (one patch applied to many tasks)
kanban tasks batch update task-1 task-2 task-3 --status done
kanban tasks batch update --file ./ids.txt --priority low --assignee alice

# Bulk-delete
kanban tasks batch delete task-1 task-2 task-3
```

YAML / JSON file schema (single object or array of objects):

```yaml
# tasks.yaml — single object
title: "Ship docs"
columnId: col-todo
priority: high
assignee: alice
meta:
  tag: docs
  sprint: q3
---
# tasks.yaml — array
- title: "Spec"
  columnId: col-todo
  priority: high
- title: "Build"
  columnId: col-doing
  status: in_progress
```

`--file` accepts UTF-8 text files; id files for `batch update` / `batch
delete` accept one id per line with `#` comments and blank lines skipped.

---

## 7. 配置文件 / Configuration files

CLI 解析所有配置时遵循四级优先级链:

The CLI resolves every setting through a four-level priority chain:

> **CLI flag > 环境变量 (env var) > 配置文件 (config file) > 内置默认值 (built-in default)**

### 7.1 全局 flag / Global flags

| Flag | Default | Description |
|---|---|---|
| `--api-url <url>` | `http://localhost:8080` | Kanban API base URL |
| `--profile <name>` | _(unset)_ | Credential profile (e.g. `work` / `personal`) |
| `--output <format>` | `table` | `table` (default) / `json`. `yaml` is accepted but currently renders as `table` |
| `--no-color` | color on | Disable ANSI color. Equivalent to `--color=off` |
| `--color <mode>` | `auto` | `on` / `off` / `auto`. Honours `NO_COLOR` / `FORCE_COLOR` |

### 7.2 环境变量 / Environment variables

| 变量 / Variable | 解析为 / Resolves to |
|---|---|
| `KANBAN_API_URL` | `apiUrl` |
| `KANBAN_CLI_PROFILE` | `profile` |
| `KANBAN_CLI_OUTPUT` | `output` |
| `KANBAN_CLI_TIMEOUT` | `timeout` (HTTP timeout ms; config-only) |
| `NO_COLOR` / `FORCE_COLOR` | ANSI color override |

### 7.3 配置文件 / Config file

默认位置 / Default location:

```
~/.config/kanban-cli/config.json          # honours XDG_CONFIG_HOME
```

写入时 mode `0600` (只有你能读写 / owner-only read/write).

```bash
# View resolved values + their source
kanban config get
# config file: ~/.config/kanban-cli/config.json
# apiUrl=http://localhost:8080 (default)
# output=table (default)
# profile=<unset> (default)
# timeout=30000 (default)

# View a single key
kanban config get apiUrl
# http://localhost:8080 (default)

# Persist a value
kanban config set apiUrl https://kanban.example.com
# stdout: set apiUrl=https://kanban.example.com
# stderr: saved to ~/.config/kanban-cli/config.json

kanban config set output json
kanban config set timeout 60000
kanban config set profile work
kanban config set profile ""      # clear the active profile
```

支持 keys / Supported keys: `apiUrl`, `output`, `profile`, `timeout`.

校验规则 / Validation rules:

| Key | Allowed values |
|---|---|
| `apiUrl` | any URL string |
| `output` | `table` / `json` / `yaml` |
| `profile` | any string (empty string clears) |
| `timeout` | positive integer (milliseconds) |

未知 key 或非法 value → 退出码 `1`,**不修改文件**。

Unknown keys or invalid values exit with code `1` and **leave the file
untouched**.

---

## 8. 脚本与管道 / Shell pipelines & scripting

### 8.1 JSON 输出 / JSON output

每个命令都支持 `--output json`,适合 `jq` / `yq` 后处理。

Every command supports `--output json`, perfect for piping into `jq` /
`yq`.

```bash
# Count tasks per status
kanban tasks list --output json | jq 'group_by(.status) | map({status: .[0].status, count: length})'

# Watch my own inbox every 30 seconds
while true; do
  clear
  kanban mine --output json | jq -r '.[] | "[\(.priority)] \(.title)"'
  sleep 30
done

# Bulk-update only the highest-priority tasks
kanban tasks list --priority high --output json \
  | jq -r '.[].id' \
  | xargs kanban tasks batch update --status in_progress
```

### 8.2 Shell 集成 / Shell integration

```bash
# Bash: assert the API is reachable before running a script
kanban status >/dev/null || { echo "kanban offline"; exit 1; }

# Cron: drain my inbox once a day at 02:30
30 2 * * *  KANBAN_API_URL=https://kanban.example.com kanban run --mine --once >> /var/log/kanban.log 2>&1

# Make: drive a workflow from a Makefile
.PHONY: sync
sync:
    kanban boards list --output json | jq -r '.[].id' | xargs -I{} kanban columns list --board {} --output json
```

### 8.3 历史 / REPL history

`kanban shell` 启动一个交互式 REPL,history 写在 `~/.kanban_shell_history`
(可被 `KANBAN_SHELL_HISTORY` 覆盖)。

`kanban shell` launches an interactive REPL; history persists at
`~/.kanban_shell_history` (override via `KANBAN_SHELL_HISTORY`).

```bash
kanban shell
# kanban> help
# kanban> boards list
# kanban> exit
```

REPL 内置命令 / Built-in REPL commands:

| Command | Description |
|---|---|
| `help` | Print REPL help |
| `exit` / `quit` | Close the REPL |
| `clear` | Clear screen (no-op when piped) |
| `whoami` | Call `GET /api/v1/users/me` |

其他输入会被分发给 `program.parseAsync(...)`,所以完整 CLI 在 REPL 里也能用。

Anything else is dispatched to `program.parseAsync(...)`, so the full
CLI surface is available inside the REPL.

---

## 9. 退出码与错误处理 / Exit codes & errors

CLI 使用稳定的 POSIX 退出码,脚本不需要解析 stderr:

The CLI uses stable POSIX exit codes so scripts can branch on outcomes
without parsing stderr:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Invalid usage (missing / conflicting flags) or other unexpected error |
| `2` | Not logged in (run `kanban auth login` first) |
| `3` | User denied / device code expired during login, **or** HTTP 404 (`NotFoundError`) |
| `4` | Server error (HTTP 5xx) |
| `5` | HTTP not_found (e.g. board / task / column id missing) |
| `6` | Network error (server unreachable, DNS failure, TLS error, …) |

**怎么用 / How to use them:**

```bash
# Stop the script if not logged in
kanban dashboard || {
  code=$?
  if [ "$code" = "2" ]; then
    echo "Please run: kanban auth login"
    exit 1
  fi
  exit "$code"
}

# Retry on network errors
kanban status || {
  code=$?
  [ "$code" = "6" ] && sleep 5 && kanban status
}
```

> **历史兼容 / Legacy note:** the docs table records both `3` (auth
> denial / expiry) and `5` (generic 404). Both mappings remain in place
> for backward compatibility — `3` covers denial and the `NotFoundError`
> thrown by `boards get` / `columns get` when the id is missing, while
> `5` covers generic 404s surfaced by the HTTP layer.

---

## 10. Runner: 让 CLI 帮你跑 agent / Runner loop

> **TL;DR:** `kanban run` 是一个常驻进程,它循环地从看板或你的 inbox 里
> 抢 (claim) 任务 → 启动你配置的 agent 二进制 → 周期性发送心跳 →
> 任务结束后把结果回报给 server。

> **TL;DR:** `kanban run` is a long-lived process that loops: claim a
> task from a board column (or your agent inbox) → spawn your configured
> agent binary → send heartbeats → POST the outcome back when the agent
> exits.

完整设计见 [`devDoc/CLI_RUNNER_PLAN_2026-09-12.md`](../devDoc/CLI_RUNNER_PLAN_2026-09-12.md);
manpage 在 [`cli/man/kanban-run.1.md`](../cli/man/kanban-run.1.md).

### 10.1 两种模式 / Two modes

| Mode | Flag pair | Use case |
|---|---|---|
| **Mode 1 (board-bound)** | `--board <id> --status <s>` | Team-pool: watch a single column |
| **Mode 2 (identity-bound)** | `--mine` | Agent inbox: pick any task assigned to your profile |

两种模式互斥 / The two modes are mutually exclusive.

### 10.2 快速上手 / Quick start

```bash
# 1. Log in once
kanban auth login

# 2a. Use the interactive wizard (recommended)
kanban run init
#    Walks through mode → board/status → agent block → runner cadences.
#    Boards and columns are fetched live so you never paste ids blind.

# 2b. Or: write the config by hand
cat > .kanban-runner.yaml <<'YAML'
version: 1
boardId: sys
status: todo
agent:
  bin: opencode
  cwd: .
  args: ["--non-interactive"]
  timeoutMs: 1800000
runner:
  pollIntervalMs: 5000
  heartbeatIntervalMs: 30000
  lockTimeoutMs: 120000
YAML

# 3. Start the loop (foreground; Ctrl-C triggers a graceful drain)
kanban run

# 4. Or: drain a single task and exit (cron-friendly)
kanban run --once

# 5. Or: watch your agent inbox instead of a fixed column
kanban run --mine
```

### 10.3 配置文件查找顺序 / Config discovery

When `--config` is not supplied, the runner walks up from `cwd` looking
for the first hit:

1. `./.kanban-runner.local.yaml` — machine-local override (gitignored)
2. `./.kanban-runner.yaml` — project-shared config (checked in)
3. `~/.config/kanban-cli/runner.json` — global fallback

当同目录下同时有 local override 和 project 文件,deep-merge 后 local 优先
(数组类字段如 `args` 整体替换)。

When both files exist at the same directory, they're deep-merged (local
wins on conflict; array fields like `args` are replaced wholesale).

### 10.4 信号处理 / Signal handling

The loop installs `SIGINT` and `SIGTERM` handlers that call
`requestShutdown()`. The current in-flight agent (if any) is sent
`SIGTERM`, the loop waits up to 15 s for it to drain, then
`POST /api/v1/runs/release` is called to release any orphan locks
before the process exits.

`Ctrl-C` 在大多数场景下都能干净退出 —— 在跑任务时按 Ctrl-C 会先 SIGTERM
agent,等最多 15 秒,然后释放锁再退出。

### 10.5 常见报错 / Common errors

| 错误 / Error | 原因 / Cause | 解决 / Fix |
|---|---|---|
| `no runner config found` | Discovery walk found nothing | Drop a `.kanban-runner.yaml` next to your code, or pass `--config <path>` |
| `config is incomplete: provide either 'boardId'+'status' or 'mode: mine'` | Picked neither mode | Add both `boardId`+`status` or set `mode: mine` |
| `config is ambiguous: 'mode: mine' is mutually exclusive with 'boardId' / 'status'` | Set both | Drop the `boardId`/`status` keys when `mode: mine` is set |
| `agent.bin '...' is neither an absolute path nor resolvable via PATH` | Bad `bin` | Use an absolute path or one on `$PATH` |
| `runner.lockTimeoutMs (...) must be greater than 2 × runner.heartbeatIntervalMs (...)` | Lock timeout too short | Bump `lockTimeoutMs` |
| `mode 'mine' requires CLI profile '<x>' to be logged in` | No OAuth session | `kanban auth login` |
| `claim failed: ... (retryable=false)` / loop exits with code 1 | 401 / 403 / token mismatch | Re-login or fix the column's `column_agents` grant |

---

## 11. 常见问答 / FAQ

### `kanban: command not found`

- You didn't install globally. Run `npm install -g open-kanban-cli` or use `npx open-kanban-cli`.
- Your global `node_modules/.bin` is not on `PATH`. Add it (`echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc`) and reload.

### `Not logged in. Run 'kanban auth login' first.`

Credentials cache is missing or expired.

```bash
kanban auth status             # what does the CLI see?
kanban auth logout             # wipe and re-login
kanban auth login
```

### `Network error` / `ECONNREFUSED`

The CLI can't reach `KANBAN_API_URL`. Verify with `kanban status` (it
marks the API as `offline` and reports latency):

- Wrong `--api-url` (run `kanban config get apiUrl` to confirm).
- Server is on `localhost` but you're inside a container / WSL / remote
  shell — use the host's reachable address (e.g. `host.docker.internal`).
- TLS error — self-signed certs require adding the cert to the OS trust
  store; the CLI does not currently accept a `--insecure-skip-verify` flag.

### `401 Unauthorized` on every call

Tokens were issued against a different API URL than the one currently
configured. Each `--api-url` (or `KANBAN_API_URL`) gets its own
credential file. Switch back to the original URL or re-run
`kanban auth logout && kanban auth login` against the new endpoint.

### `exit code 3: DeniedAuthorizationError`

OAuth login was denied or the device code expired (default 600 s). Re-run
`kanban auth login` and approve faster.

### `exit code 1: invalid --fields value: ...`

`kanban tasks list --fields` only accepts `id` or `id+updated`. Anything
else fails fast (no HTTP traffic). Drop `--fields` for the default
projection.

### `--output yaml` renders as a table

`yaml` is accepted by the flag for forward compatibility, but the
renderers currently normalise anything other than `json` to `table`.
Use `--output json` and pipe through `yq` / `jq` for now.

### `mine` output looks wrong

`kanban mine --board <id>` prints
`warning: --board is not supported by /api/v1/mcp/my-tasks; ignoring boardId=<id>`
to stderr. The flag is a forward-compatibility shim — the endpoint does
not accept a board filter. Drop the flag and filter client-side instead.

### How do I uninstall the CLI?

```bash
npm uninstall -g open-kanban-cli
rm -rf ~/.config/kanban-cli   # wipe config + credentials
```

---

## 下一步 / Where to go next

- 全 flag 参考 / Full flag reference: [`docs/CLI_COMMANDS.md`](./CLI_COMMANDS.md)
- 故障排查 + 退出码表 / Troubleshooting + exit codes: [`cli/README.md`](../cli/README.md)
- Runner 详细设计 / Runner design: [`devDoc/CLI_RUNNER_PLAN_2026-09-12.md`](../devDoc/CLI_RUNNER_PLAN_2026-09-12.md)
- OpenAPI 规约 / API spec: [`docs/openapi.yaml`](./openapi.yaml)
- Manpage / `man kanban`: [`cli/man/kanban.1`](../cli/man/kanban.1)
