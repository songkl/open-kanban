# Open Kanban CLI（命令行客户端）

`kanban` 是 [Open Kanban](https://github.com/songkl/open-kanban) 看板的命令行客户端。它使用 OAuth 2.1（RFC 7591 + RFC 8628）完成身份认证，覆盖 HTTP API 暴露的所有读写接口，并以带 ANSI 颜色的表格或 JSON 两种形式输出结果，方便脚本与管线消费。

> **GitHub：** https://github.com/songkl/open-kanban
> **English README：** [README.md](./README.md)

## 这是什么？

Open Kanban 提供三种驱动看板的方式：

| 形态 | 使用对象 | 协议 | 适用场景 |
|---|---|---|---|
| **Web UI**（React） | 人 | 浏览器 | 拖拽编辑、仪表盘 |
| **MCP server**（`open-kanban-mcp`） | AI Agent | Model Context Protocol | 让 Claude Code / Cursor / OpenCode 等自主操作看板 |
| **CLI**（`kanban`，本包） | 人 + 脚本 | OAuth 2.1 over HTTP | Shell 管道、CI、cron、跨语言脚本 |

### CLI 与 MCP 的区别——什么时候用哪个？

- **CLI**：需要人类可读的命令、shell 管道、定时任务或脱离 MCP 环境的脚本时使用。CLI 通过纯 HTTPS 与服务通信，凭据存储在 MCP server 使用的同一目录（`$XDG_CONFIG_HOME`），因此两者可以指向同一个工作区。
- **MCP server**：当 LLM 宿主（Claude Code、Cursor、OpenCode…）需要操作看板时使用。它将 CLI 的所有端点暴露成 MCP 工具，由模型决定调用方式。

两者使用相同的认证流程，因此你在终端里 `kanban auth login` 之后，本地的 MCP server 会复用同一份凭据。

## 安装

CLI 是 Node.js（>= 18）二进制。按工作流选择合适的安装方式：

### `npm`（本地安装）

```bash
cd cli
npm install
npm run build
# 二进制位于 ./dist/index.js
node ./dist/index.js --help
```

### `npx`（无需安装）

```bash
# 包发布到 npm 之后：
npx -y open-kanban-cli --help
```

### 全局 `npm`

```bash
npm install -g open-kanban-cli
kanban --help
```

### Homebrew（计划中）

> Homebrew tap 暂未发布。请关注 [GitHub issue #TBD](https://github.com/songkl/open-kanban/issues) 跟踪 tap 公式。正式发布后：
>
> ```bash
> brew install songkl/tap/kanban
> kanban --help
> ```

安装完成后，请确认 Node ≥ 18 已加入 `PATH`：

```bash
node --version   # 必须打印 v18.x 或更高
```

## 快速开始

完整演示——登录、检查工作区、创建任务并推动其流转：

```bash
# 1. 指定 Kanban 服务地址（默认 http://localhost:8080）
export KANBAN_API_URL="https://kanban.example.com"

# 2. 通过 OAuth 2.1 device flow 登录
kanban auth login
#   → 按提示访问 URL、输入用户码、在浏览器中确认授权
#   → 如果 server 检测到是 CLI / MCP client，会额外展示一个
#     "Authorise as" 选择器——选 **Myself** 表示把 token 绑到你
#     自己的账号，选一个已启用的 Agent（如果 admin 在
#     `oauth_device_agent_id` 里配了全局默认，就会被预选中）。
#     详见 [Device-flow Agent 选择](../docs/CLI_COMMANDS.md#device-flow-agent-selection)。

# 3. 检查工作区
kanban status          # 探测 API，打印延迟与看板数量
kanban boards list     # 列出所有看板（公开端点，无需登录）
kanban columns list    # 列出列及其状态

# 4. 在默认看板上创建任务
kanban tasks create --title "发布文档" --priority high

# 5. 推动任务流转
kanban tasks move <id> --status in_progress
kanban tasks complete <id>      # 推进到下一列
```

> **给 `kanban run` 运维者的提示：** 每个 `kanban run` 部署**必须**
> 持有 `users.type='AGENT'` 的 bearer。在 device flow 授权页请选择
> 一个 Agent——选 "Myself" 会让 `/api/v1/runs/claim` 抢不到任务。
> 端到端教程见
> [`docs/CLI_USER_GUIDE.md` §2.2](../docs/CLI_USER_GUIDE.md#22-device-flow-agent-选择--pick-which-identity-the-device-flow-binds-to)。

CLI 将签发的 token 存储于
`$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json`（权限 `0600`）。
访问令牌会在每次请求前自动刷新，因此后续调用无需重新登录。

清除本地凭据：

```bash
kanban auth logout
```

## 命令一览

> 第一次用 CLI？先看 [**docs/CLI_USER_GUIDE.md**](../docs/CLI_USER_GUIDE.md)
> —— 一份中英文混合、按场景走完整套常用流程的入门教程,每个步骤都有可
> 直接拷贝的示例。

完整的 flag 级参考文档（每个选项、每个示例）请见
[**docs/CLI_COMMANDS.md**](../docs/CLI_COMMANDS.md)。下面是命令树的高层结构：

| 命令组 | 用途 | 是否需要登录 |
|---|---|---|
| [`auth`](../docs/CLI_COMMANDS.md#auth--authentication) | OAuth 2.1 登录 / 状态 / 登出 / whoami | 部分 |
| [`status`](../docs/CLI_COMMANDS.md#status--api-probe) | 探测 API 并打印可达性 | 公开 |
| [`dashboard`](../docs/CLI_COMMANDS.md#dashboard--workspace-stats) | 工作区总量 + 按状态 / 优先级分布 | 需要 |
| [`boards`](../docs/CLI_COMMANDS.md#boards--board-navigation) | 列出 / 获取看板 | 公开 |
| [`columns`](../docs/CLI_COMMANDS.md#columns--column-navigation) | 列出 / 获取列（含内嵌任务） | 公开 |
| [`tasks`](../docs/CLI_COMMANDS.md#tasks--task-crud) | 增 / 查 / 改 / 删 / 移动 / 完成 | 部分 |
| [`tasks batch`](../docs/CLI_COMMANDS.md#tasks-batch--bulk-operations) | 通过文件或重复 flag 批量创建 / 更新 / 删除 | 需要 |
| [`drafts`](../docs/CLI_COMMANDS.md#drafts--draft-tasks) | 管理未发布的草稿任务 | 需要 |
| [`archived`](../docs/CLI_COMMANDS.md#archived--archived-tasks) | 列出 / 归档 / 恢复 | 需要 |
| [`comments`](../docs/CLI_COMMANDS.md#comments--task-comments) | 新增（含 stdin）/ 列出 | 需要 |
| [`subtasks`](../docs/CLI_COMMANDS.md#subtasks--task-subtasks) | 创建 / 更新 / 完成 / 删除 | 需要 |
| [`mine`](../docs/CLI_COMMANDS.md#mine--current-agent-tasks) | 当前 Agent 名下的任务 | 需要 |
| [`run`](../docs/CLI_COMMANDS.md#run--runner-loop) | Runner 循环（抢任务 → 拉起 agent → 心跳 → 回报） | 部分 |
| [`runs`](../docs/CLI_COMMANDS.md#runs--terminal-task-run-history) | 查看已结束的 task-run 历史 | 需要 |
| [`workspace`](../docs/CLI_COMMANDS.md#workspace--workspace-files) | 工作区文件上传 / 读取 / 列出 / 删除 | 需要 |
| [`shell`](../docs/CLI_COMMANDS.md#shell--interactive-repl) | 交互式 REPL | — |
| [`completion`](../docs/CLI_COMMANDS.md#completion--shell-completion) | 输出 bash / zsh / fish 自动补全脚本 | — |
| [`config`](../docs/CLI_COMMANDS.md#config--view--update-settings) | 查看 / 更新 CLI 持久化配置 | — |

每个 flag 的细节与可运行示例见
[**docs/CLI_COMMANDS.md**](../docs/CLI_COMMANDS.md)。

### 常用工作流示例

```bash
# 查看当前应当处理的任务
kanban mine

# 更新任务并追加一条评论
kanban tasks update t-42 --priority high
echo "已提升为 high，阻塞发布。" \
  | kanban comments add t-42 --body -

# 把分配给 alice 的所有 todo 批量移到 in_progress
kanban tasks batch update --assignee alice \
  --status in_progress --column col-doing

# 上传 markdown 规约到工作区
kanban workspace upload ./spec.md --path specs/spec.md
```

## 配置

CLI 通过四级优先级链解析所有配置：

**CLI flag > 环境变量 > 配置文件 > 内置默认值**

### 全局 flag

| Flag | 默认值 | 说明 |
|---|---|---|
| `--api-url <url>` | `http://localhost:8080` | Kanban API 地址。 |
| `--profile <name>` | _(未设置)_ | profile 名。可在同一台机器上保留多个账号（如 `work` 与 `personal`），互不覆盖。 |
| `--output <format>` | `table` | 输出格式：`table` 或 `json`。（`yaml` 已被 flag 接受，但当前仍按 `table` 渲染。） |
| `--no-color` | color 开启 | 关闭表格的 ANSI 颜色。等价于 `--color=off`。 |
| `--color <mode>` | `auto` | 强制颜色：`on` / `off` / `auto`。遵循 `NO_COLOR` 与 `FORCE_COLOR`。 |

### 环境变量

| 变量 | 解析为 |
|---|---|
| `KANBAN_API_URL` | `apiUrl` |
| `KANBAN_CLI_PROFILE` | `profile` |
| `KANBAN_CLI_OUTPUT` | `output` |
| `KANBAN_CLI_TIMEOUT` | `timeout`（HTTP 超时毫秒；仅通过配置生效） |
| `NO_COLOR` / `FORCE_COLOR` | ANSI 颜色覆盖 |

### 配置文件

持久化配置位于
`~/.config/kanban-cli/config.json`（或
`${XDG_CONFIG_HOME}/kanban-cli/config.json`），写入权限为 `0600`。

```bash
# 查看解析后的值
kanban config get

# 设置值
kanban config set apiUrl https://kanban.example.com
kanban config set output json
kanban config set timeout 60000
kanban config set profile work

# 清除当前 profile
kanban config set profile ""
```

支持的 key：`apiUrl`、`output`、`profile`、`timeout`。校验规则见
[`config get / set`](../docs/CLI_COMMANDS.md#config--view--update-settings)。

## 退出码

CLI 使用稳定的 POSIX 风格退出码，脚本无需解析 stderr 即可根据退出码分支：

| 退出码 | 含义 |
|---|---|
| `0` | 成功。 |
| `1` | 用法错误（缺失 / 冲突的 flag）或其他未预期错误。 |
| `2` | 未登录（请先运行 `kanban auth login`）。 |
| `3` | 用户拒绝授权 / 设备码过期，**或** HTTP 404（`NotFoundError`）。 |
| `4` | 服务端错误（HTTP 5xx）。 |
| `5` | 资源未找到（如看板 / 任务 / 列 id 缺失）。 |
| `6` | 网络错误（服务不可达、DNS 失败、TLS 错误等）。 |

> 说明：旧 README 将 `5` 记作 `not_found`、`3` 记作授权拒绝 / 过期。当前两套映射仍并存——`3` 同时覆盖授权拒绝与 `boards get` / `columns get` 抛出 `NotFoundError` 的场景，而 `5` 覆盖 HTTP 层上报的通用 404。

## 故障排查

### `kanban: command not found`

- 没有全局安装。运行 `npm install -g open-kanban-cli` 或直接使用
  `npx open-kanban-cli`。
- 全局 `node_modules/.bin` 不在 `PATH` 上。可追加
  `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc` 后重载。

### `Not logged in. Run 'kanban auth login' first.`

凭据缓存缺失或已失效。

```bash
# 检查 CLI 当前持有的凭据
kanban auth status

# 若缓存为空或错误，先登出再重新登录
kanban auth logout
kanban auth login
```

若 `auth login` 一直打印 `DeniedAuthorizationError`，请确认打印到 stderr 的
验证 URL 与用户码，并确认浏览器登录的账号就是预期用户。

### `Network error` / `ECONNREFUSED`

CLI 无法连接 `KANBAN_API_URL`。可用 `kanban status` 验证，它会把 API
标记为 `offline` 并报告延迟。常见原因：

- `--api-url` 错误（运行 `kanban config get apiUrl` 核对）。
- 服务在 `localhost`，但你在容器 / WSL / 远程 shell 内——使用宿主机可达地址
  （如 `host.docker.internal`）。
- TLS 错误：自签名证书需要加入操作系统信任库；CLI 暂未提供 `--insecure-skip-verify`。

### 每次都 `401 Unauthorized`

token 是针对另一个 API URL 签发的。每个 `--api-url`（或 `KANBAN_API_URL`）
对应一个独立的凭据文件 `credentials-<api>.json`。请切回原始 URL 或针对
新端点重新运行 `kanban auth logout && kanban auth login`。

### `exit code 3: DeniedAuthorizationError`

OAuth 登录被拒绝或设备码已过期（默认 600 秒）。重新运行
`kanban auth login` 并在有效期内完成授权。

### `exit code 1: invalid --fields value: ...`

`kanban tasks list --fields` 只接受 `id` 或 `id+updated`，其他值会快速失败
（不产生 HTTP 请求）。如需默认字段投影，去掉 `--fields` 即可。

### `mine` 输出不符合预期

`kanban mine --board <id>` 会向 stderr 输出
`warning: --board is not supported by /api/v1/mcp/my-tasks; ignoring boardId=<id>`。
该 flag 是前向兼容占位——当前端点不接受 board 过滤。请去掉该 flag，改为在
客户端二次过滤。

### `--output yaml` 渲染为表格

`--output` flag 已接受 `yaml`，但 action handler 当前把所有非 `json` 的
值都归一化为 `table`。暂时可改用 `--output json` 并通过 `yq` / `jq` 进一步处理。

## 开发

```bash
npm install            # 安装依赖
npm run lint           # tsc --noEmit（类型检查）
npm test               # vitest run（单元 + e2e 测试集）
npm run build          # tsc + shebang → ./dist/index.js
npm run dev            # tsc --watch（保存即重编译）
```

测试与源码位于同一目录（`src/**/*.test.ts`）；顶层集成测试位于 `tests/`，
通过 mock `fetch` 模拟服务端，覆盖完整的
`auth login → boards list → tasks list → tasks complete` 流程。

## Shell 自动补全

CLI 自带 bash / zsh / fish 自动补全脚本。静态建议（子命令、flag、合法
枚举值）已内嵌到脚本中，因此即使 API 不可达也能即时补全；动态值
（boardId / columnId / taskId …）在 <kbd>Tab</kbd> 时通过
`kanban __complete <line>` 懒加载。

```bash
# bash —— 全局安装（需要 bash-completion）：
kanban completion bash | sudo tee /etc/bash_completion.d/kanban

# bash —— 当前用户：
kanban completion bash > ~/.kanban-completion.bash
echo 'source ~/.kanban-completion.bash' >> ~/.bashrc

# zsh —— 放到 $fpath：
kanban completion zsh > "${fpath[1]}/_kanban"
autoload -Uz compinit && compinit

# fish —— 当前会话 / 持久化：
kanban completion fish | source
kanban completion fish > ~/.config/fish/completions/kanban.fish
```

另提供 manpage（`cli/man/kanban.1`），可通过 `man kanban` 查看。

## 许可证

MIT
