// Simplified Chinese message dictionary for the Open Kanban CLI.
//
// Only keys whose translation genuinely differs from English need to be
// listed here — `i18n/index.ts` falls back to the English string for any
// missing key, so a partial translation never breaks the CLI. New
// commands that need translation should add the corresponding key here
// when the Chinese copy is ready; until then the English fallback keeps
// the help text intelligible.
//
// Translation style notes:
//   * No trailing full stops in option descriptions — they read as part
//     of the help line and don't need punctuation.
//   * English identifiers (CLI flag names, HTTP endpoints, s-#### ticket
//     numbers) are kept verbatim so users can correlate the Chinese help
//     with the English docs / source.
//   * "<…>" placeholders stay verbatim.

import type { EnglishMessageKey } from "./en.js";

export const zh: Partial<Record<EnglishMessageKey, string>> = {
  // Top-level CLI
  "cli.description": "Open Kanban 命令行客户端 - 用于操作 Open Kanban 看板",
  "cli.option.apiUrl": "Kanban API 服务地址",
  "cli.option.profile": "要使用的凭据配置（profile）",
  "cli.option.output": "输出格式（table|json|yaml）",
  "cli.option.noColor": "关闭 ANSI 颜色输出",
  "cli.option.color": "强制颜色输出开关（on|off|auto）",
  "cli.option.lang": "覆盖界面语言（auto|en|zh）；默认读取 LANG 环境变量",

  // auth
  "cli.auth.description": "管理 CLI 身份认证",
  "cli.auth.login.description":
    "为 CLI 完成身份认证。默认会启动 OAuth 2.1 设备授权码流程（基于浏览器）。当处于 TTY 且未显式指定模式标志时，会交互式地询问：把令牌绑定到 Agent，还是绑定到当前账号（s-1246）。可通过 --as-human / --as-agent 跳过询问。快捷方式：--user <用户名> --password <密码> 会直接走传统的用户名 / 密码登录，兑换出长效 bearer token（s-1275），无需打开浏览器；--password-stdin 表示从 stdin 读取密码。",
  "cli.auth.login.opt.asHuman":
    "把令牌绑定到当前人类审批者的账号，覆盖默认的 Agent 身份（s-1231）",
  "cli.auth.login.opt.asAgent":
    "显式把令牌绑定到 Agent 身份；当 stdin 为 TTY 时跳过交互式身份选择（s-1246）",
  "cli.auth.login.opt.noOpen":
    "不在默认浏览器中打开验证 URL（仅 agent 模式有效）",
  "cli.auth.login.opt.user":
    "通过 POST /api/auth/login，用用户名 + 密码兑换长效 bearer token（s-1275）；同时必须提供 --password。不能与 --as-human / --as-agent 同时使用。",
  "cli.auth.login.opt.password":
    "--user 对应的密码（s-1275）。为避免留下 shell 历史，推荐管道输入：read -s PW && kanban auth login --user admin --password \"$PW\"，或使用 --password-stdin / KANBAN_CLI_PASSWORD。",
  "cli.auth.login.opt.passwordStdin":
    "从 stdin 读取密码（一行），代替 --password（s-1275）",
  "cli.auth.login.err.mixPasswordWithMode":
    "不能同时使用 --user/--password 与 --as-human / --as-agent；密码登录方式只能绑定到给定的用户名。",
  "cli.auth.login.err.missingUser":
    "kanban auth login --user <用户名> --password <密码>：必须提供 --user",
  "cli.auth.login.err.mixAsHumanAsAgent":
    "不能同时指定 --as-human 与 --as-agent；请二选一。",
  "cli.auth.status.description": "显示当前配置：profile、host、scope、token 有效期",
  "cli.auth.logout.description": "删除本地保存的凭据",
  "cli.auth.whoami.description":
    "调用 GET /api/v1/users/me，并展示当前登录的用户",
  "cli.auth.whoami.opt.path": "覆盖 whoami 端点路径",

  // auth agent
  "cli.auth.agent.description":
    "管理绑定到 CLI 的 Agent 身份（用于无人值守 / 自动化场景）",
  "cli.auth.agent.list.description":
    "列出服务器上已配置的 Agent（需要管理员 OAuth 会话）",
  "cli.auth.agent.create.description":
    "在服务器上创建新的 Agent，并将其 API token 绑定到当前 CLI 配置（需要管理员 OAuth 会话）",
  "cli.auth.agent.create.opt.avatar": "新 Agent 的头像 URL",
  "cli.auth.agent.create.opt.role": "新 Agent 的角色（ADMIN|MEMBER|VIEWER）",
  "cli.auth.agent.create.opt.noBind":
    "不把生成的 token 持久化到凭据存储（演练模式）",
  "cli.auth.agent.create.err.invalidRole":
    "非法的 --role：{{value}}。请使用 ADMIN、MEMBER 或 VIEWER 之一。",
  "cli.auth.agent.bind.description":
    "把 CLI 绑定到一个已存在的 Agent API token（可通过 Web UI 或 `kanban auth agent create` 颁发）",
  "cli.auth.agent.bind.opt.token":
    "要持久化的 Agent API token（否则读取 KANBAN_AGENT_TOKEN，否则交互提示）",
  "cli.auth.agent.bind.prompt.token": "Agent API token：",
  "cli.auth.agent.bind.prompt.tokenRequired": "token 不能为空",
  "cli.auth.agent.login.description":
    "启动 OAuth 设备流程，并在审批页面中把 CLI 绑定到选定的 Agent 身份",
  "cli.auth.agent.login.opt.noOpen":
    "不在默认浏览器中打开验证 URL",
  "cli.auth.agent.delete.description": "删除一个 Agent（需要管理员 OAuth 会话）",

  // status / dashboard
  "cli.status.description":
    "探测 Kanban API，并报告延迟 / 看板数量 / apiUrl",
  "cli.dashboard.description":
    "请求 GET /api/v1/dashboard/stats，并以表格形式输出汇总信息",

  // boards
  "cli.boards.description": "管理看板",
  "cli.boards.list.description": "列出未删除的看板（GET /api/v1/boards）",
  "cli.boards.list.opt.fields": "逗号分隔的字段列表",
  "cli.boards.get.description": "获取单个看板（GET /api/v1/boards/:id）",
  "cli.boards.get.opt.fields": "逗号分隔的字段列表",

  // columns
  "cli.columns.description": "管理列",
  "cli.columns.list.description": "列出列（GET /api/v1/columns）",
  "cli.columns.list.opt.board": "按看板 ID 过滤",
  "cli.columns.list.opt.positions":
    "逗号分隔的位置列表（例如 1,3,5）",
  "cli.columns.list.opt.fields": "逗号分隔的字段列表",
  "cli.columns.get.description": "获取单个列（GET /api/v1/columns/:id）",
  "cli.columns.get.opt.fields": "逗号分隔的字段列表",

  // tasks
  "cli.tasks.description": "管理任务",
  "cli.tasks.list.description":
    "列出任务（基于 GET /api/v1/columns 在客户端做过滤）",
  "cli.tasks.list.opt.board": "按看板 ID 过滤",
  "cli.tasks.list.opt.column":
    "按列 ID 过滤（与 --status 互斥）",
  "cli.tasks.list.opt.status":
    "按状态过滤（todo|in_progress|review|done）；与 --column 互斥",
  "cli.tasks.list.opt.agentType": "按 column agentConfig.agentTypes 过滤",
  "cli.tasks.list.opt.priority": "按优先级过滤（low|medium|high）",
  "cli.tasks.list.opt.assignee": "按负责人的用户名过滤",
  "cli.tasks.list.opt.search": "在标题与描述中做自由文本搜索",
  "cli.tasks.list.opt.since": "按创建时间过滤（today|thisWeek|thisMonth）",
  "cli.tasks.list.opt.tag": "按 meta 字段做子串匹配",
  "cli.tasks.list.opt.lightweight":
    "只返回 id/title/priority/assignee/createdAt（默认行为）",
  "cli.tasks.list.opt.fields": "变更检测字段集（id|id+updated）",
  "cli.tasks.list.err.invalidFields":
    "非法的 --fields 值：{{value}}（允许：id, id+updated）",
  "cli.tasks.get.description": "获取单个任务（GET /api/v1/tasks/:id）",
  "cli.tasks.create.description": "创建一个任务（POST /api/v1/tasks）",
  "cli.tasks.create.opt.title": "任务标题（必填）",
  "cli.tasks.create.opt.description": "任务描述",
  "cli.tasks.create.opt.column":
    "目标列 ID（与 --status 互斥）",
  "cli.tasks.create.opt.status":
    "目标状态（todo|in_progress|review|done）；与 --column 互斥",
  "cli.tasks.create.opt.board": "用于 status→column 解析的默认看板",
  "cli.tasks.create.opt.priority":
    "任务优先级（low|medium|high）；默认 medium",
  "cli.tasks.create.opt.assignee": "任务负责人用户名",
  "cli.tasks.create.opt.meta":
    "meta 键值对（可重复或逗号分隔）",
  "cli.tasks.create.opt.noPublish": "创建为草稿，不发布任务",
  "cli.tasks.update.description": "更新任务（PUT /api/v1/tasks/:id）",
  "cli.tasks.update.opt.title": "新的标题",
  "cli.tasks.update.opt.description": "新的描述",
  "cli.tasks.update.opt.priority": "新的优先级（low|medium|high）",
  "cli.tasks.update.opt.assignee": "新的负责人用户名",
  "cli.tasks.update.opt.meta":
    "新的 meta 键值对（可重复或逗号分隔）",
  "cli.tasks.update.opt.column":
    "把任务移动到此列（与 --status 互斥）",
  "cli.tasks.update.opt.status":
    "把任务移动到该状态对应的列（todo|in_progress|review|done）；与 --column 互斥",
  "cli.tasks.delete.description":
    "删除任务（DELETE /api/v1/tasks/:id）；--yes 跳过确认",
  "cli.tasks.delete.opt.yes": "跳过确认提示（默认行为）",
  "cli.tasks.complete.description":
    "把任务标记为完成（移动到看板上 done 列）POST /api/v1/tasks/:id/complete",
  "cli.tasks.advance.description":
    "把任务向前推进一列（POST /api/v1/tasks/:id/advance）",
  "cli.tasks.move.description":
    "把任务移动到目标列或目标状态（PUT /api/v1/tasks/:id，附带 columnId）",
  "cli.tasks.move.opt.column":
    "目标列 ID（与 --status 互斥）",
  "cli.tasks.move.opt.status":
    "目标状态（todo|in_progress|review|done）；与 --column 互斥",

  // tasks batch
  "cli.tasks.batch.description": "批量任务操作（创建 / 更新 / 删除）",
  "cli.tasks.batch.create.description":
    "批量创建任务（POST /api/v1/tasks/batch）；输入来自 --file 或重复使用 --title/--column 等标志",
  "cli.tasks.batch.create.opt.file":
    "从 JSON 或 YAML 文件读取任务（单个对象或对象数组）",
  "cli.tasks.batch.create.opt.title": "任务标题；多次指定以创建多个任务",
  "cli.tasks.batch.create.opt.description": "任务描述",
  "cli.tasks.batch.create.opt.column": "目标列 ID",
  "cli.tasks.batch.create.opt.status":
    "目标状态（todo|in_progress|review|done）",
  "cli.tasks.batch.create.opt.priority": "任务优先级（low|medium|high）",
  "cli.tasks.batch.create.opt.assignee": "任务负责人用户名",
  "cli.tasks.batch.create.opt.published": "把每个任务发布出去（默认行为）",
  "cli.tasks.batch.update.description":
    "批量更新任务（PUT /api/v1/tasks/batch），共享同一个 column/status/priority/assignee",
  "cli.tasks.batch.update.opt.file":
    "从 UTF-8 文本文件读取 id（每行一个，允许 # 注释）",
  "cli.tasks.batch.update.opt.column":
    "把任务移动到此列（与 --status 互斥）",
  "cli.tasks.batch.update.opt.status":
    "把任务移动到该状态对应的列（todo|in_progress|review|done）；与 --column 互斥",
  "cli.tasks.batch.update.opt.priority": "新的优先级（low|medium|high）",
  "cli.tasks.batch.update.opt.assignee": "新的负责人用户名",
  "cli.tasks.batch.delete.description":
    "批量删除任务（DELETE /api/v1/tasks/batch）；--yes 是默认行为，可省略",
  "cli.tasks.batch.delete.opt.file":
    "从 UTF-8 文本文件读取 id（每行一个，允许 # 注释）",
  "cli.tasks.batch.delete.opt.yes": "跳过确认提示（默认行为）",
  "cli.tasks.batch.err.invalidBoolean":
    "非法的布尔值：{{value}}（允许：true|false）",

  // drafts
  "cli.drafts.description": "管理草稿任务",
  "cli.drafts.list.description": "列出草稿任务（GET /api/v1/drafts）",
  "cli.drafts.list.opt.board": "按看板 ID 过滤",
  "cli.drafts.publish.description":
    "把草稿任务发布出去（POST /api/v1/drafts/:id/publish）",
  "cli.drafts.unpublish.description":
    "取消发布任务（POST /api/v1/drafts/:id/unpublish）",

  // archived
  "cli.archived.description": "管理已归档任务",
  "cli.archived.list.description": "列出已归档的任务（GET /api/v1/archived）",
  "cli.archived.archive.description": "归档一个任务（POST /api/v1/archived/:id）",
  "cli.archived.restore.description":
    "恢复一个已归档的任务（POST /api/v1/archived/:id/restore）",

  // comments
  "cli.comments.description": "管理任务评论",
  "cli.comments.add.description": "给任务添加评论",
  "cli.comments.add.opt.body": "评论正文（缺省时从 stdin 读取）",
  "cli.comments.add.opt.author":
    "可选的作者覆盖（服务器默认使用当前登录用户）",
  "cli.comments.list.description": "列出任务的全部评论",

  // subtasks
  "cli.subtasks.description": "管理任务子项",
  "cli.subtasks.list.description": "列出任务的子项",
  "cli.subtasks.create.description": "为任务创建一个子项",
  "cli.subtasks.create.opt.title": "子项标题",
  "cli.subtasks.update.description":
    "更新子项（PUT /api/v1/subtasks/:id）；可同时传 --title 和 --completed/--no-completed",
  "cli.subtasks.update.opt.title": "新的子项标题",
  "cli.subtasks.update.opt.completed":
    "把子项标记为已完成（用 --no-completed 反过来标记为未完成）",
  "cli.subtasks.delete.description": "删除一个子项",

  // mine
  "cli.mine.description": "列出分配给当前用户 / Agent 的任务",
  "cli.mine.opt.board": "按看板 ID 过滤",
  "cli.mine.opt.column": "按列 ID 过滤",
  "cli.mine.opt.status": "按状态过滤",
  "cli.mine.opt.priority": "按优先级过滤（low|medium|high）",
  "cli.mine.opt.tag": "按 meta 标签过滤",
  "cli.mine.opt.limit": "最多返回的任务数量",

  // run / runs
  "cli.run.description": "运行执行器循环（start）或生成其配置（init）",
  "cli.run.start.description":
    "启动执行器循环（claim → spawn agent → heartbeat → finish）",
  "cli.run.opt.config":
    ".kanban-runner{.local}.yaml 的明确路径；覆盖向上搜索的默认行为",
  "cli.run.opt.board": "mode-1 监听的看板 id（必须与 --status 一起使用）",
  "cli.run.opt.status":
    "mode-1 监听的列状态（todo|in_progress|review|done）；必须与 --board 一起使用",
  "cli.run.opt.mine":
    "mode-2：选取分配（或路由）给当前已认证 Agent 的任务",
  "cli.run.opt.once": "处理一个任务后立即退出；适合 cron / smoke 测试",
  "cli.run.opt.debug":
    "在 stderr 打印详细 trace 日志（claim 尝试、轮询延迟、spawn 细节、hydration、结果）",
  "cli.run-init.description":
    "交互式创建 .kanban-runner{.local}.yaml（mode、agent、runner）",
  "cli.runs.description": "管理已持久化的运行（通过 `kanban run` 启动）",
  "cli.runs.list.description":
    "列出过去的任务运行（需要认证）；支持 --runner-id, --since, --status, --task, --board, --limit, --offset",
  "cli.runs.list.opt.runnerId":
    "按执行器标识精确过滤（转发为 ?runnerId=）",
  "cli.runs.list.opt.since":
    "finished_at 的下限；支持 1d/2h/30m 这样的相对时长，或 RFC3339/YYYY-MM-DD 绝对时间",
  "cli.runs.list.opt.status":
    "按终止状态过滤（completed|failed|released）",
  "cli.runs.list.opt.task": "按任务 id 过滤（转发为 ?taskId=）",
  "cli.runs.list.opt.board": "按看板 id 过滤（转发为 ?boardId=）",
  "cli.runs.list.opt.limit": "分页大小；服务端默认 50，上限 200",
  "cli.runs.list.opt.offset": "分页偏移",
  "cli.runs.cancel.description": "取消已持久化的运行",
  "cli.runs.err.invalidLimit":
    "非法的 --limit 值：{{value}}（必须为整数）",
  "cli.runs.err.invalidOffset":
    "非法的 --offset 值：{{value}}（必须为非负整数）",
  "cli.attach.description":
    "把当前执行器附加到指定的任务 id（POST /api/v1/runs/:taskId/attach）；AI 优先入口，不要求拥有所在列",
  "cli.attach.opt.runnerId":
    "稳定的执行器标识（默认 <host>-<pid>-<uuid>）；heartbeat/finish 用它来校验归属",
  "cli.attach.opt.agentType":
    "执行器愿意接收的 Agent 类型；默认 KANBAN_RUNNER_AGENT_TYPE 或 'opencode'",
  "cli.attach.opt.lockTimeoutMs":
    "锁的 TTL（毫秒）；默认采用服务端的 DefaultRunLockTimeoutMs",
  "cli.attach.opt.reason":
    "附加在审计活动中的自由文本备注，便于把人工升级和扫描器抓取区分开来",
  "cli.attach.err.invalidLockTimeout":
    "非法的 --lock-timeout-ms 值：{{value}}（必须为正整数）",

  // workspace
  "cli.workspace.description": "管理工作区文件",
  "cli.workspace.upload.description":
    "上传本地文本文件到工作区（POST /api/v1/workspace/upload）",
  "cli.workspace.upload.opt.path":
    "上传到工作区后的相对路径（缺省取本地文件 basename）",
  "cli.workspace.batch.description":
    "在一次请求中批量上传本地文本文件（POST /api/v1/workspace/batch-upload）",
  "cli.workspace.list.description":
    "列出工作区文件（GET /api/v1/workspace/files）",
  "cli.workspace.list.opt.path": "按工作区下的子目录过滤",
  "cli.workspace.read.description":
    "读取一个工作区文件（GET /api/v1/workspace/files/<id>）；默认把原始内容写到 stdout，加 --output json 时输出 base64 payload",
  "cli.workspace.delete.description":
    "删除一个工作区文件（DELETE /api/v1/workspace/files/<id>）；--yes 是默认",
  "cli.workspace.stats.description":
    "显示工作区统计信息（GET /api/v1/workspace/stats）",

  // shell
  "cli.shell.description": "启动交互式 REPL；输入 `exit`（或 Ctrl-D）退出",

  // completion
  "cli.completion.description": "输出 Shell 自动补全脚本（bash|zsh|fish）",
  "cli.completion.bash.description": "输出 bash 自动补全脚本到 stdout",
  "cli.completion.zsh.description": "输出 zsh 自动补全脚本到 stdout",
  "cli.completion.fish.description": "输出 fish 自动补全脚本到 stdout",
  "cli.complete.description": "内部命令——供 Shell 脚本动态补全使用",
  "cli.complete.err.unsupportedShell":
    "自动补全生成器不支持此 Shell（已尝试：bash, zsh, fish, pwsh）",

  // config
  "cli.config.description":
    "查看或修改 CLI 配置（API URL, profile, output, timeout）",
  "cli.config.get.description":
    "打印 <key> 的有效值（apiUrl|output|profile|timeout）；缺省时连同来源一起打印全部支持的 key",
  "cli.config.set.description":
    "把 <key>=<value> 写入 ~/.config/kanban-cli/config.json；支持的 key：apiUrl, output, profile, timeout",
  "cli.config.err.invalidKey":
    "非法的配置项：{{value}}（支持：apiUrl, output, profile, timeout）",
  "cli.config.err.invalidOutput":
    "非法的 --output：{{value}}（允许：table|json|yaml）",
  "cli.config.err.invalidTimeout":
    "非法的 --timeout：{{value}}（必须为正整数秒）",

  // agent
  "cli.agent.description": "管理服务器上的 Agent",
  "cli.agent.list.description": "列出已配置的 Agent",
  "cli.agent.create.description": "在服务器上创建一个新的 Agent",
  "cli.agent.create.opt.nickname": "Agent 昵称",
  "cli.agent.create.opt.avatar": "Agent 头像 URL",
  "cli.agent.create.opt.role": "Agent 角色（ADMIN|MEMBER|VIEWER）",
  "cli.agent.bind.description": "把 CLI 绑定到一个 Agent API token",
  "cli.agent.login.description": "通过 OAuth 设备流程登录",
  "cli.agent.delete.description": "删除一个 Agent",

  // login mode picker prompt
  "cli.auth.login.prompt.identity": "把 CLI 绑定到哪个身份？",
  "cli.auth.login.prompt.identity.agent":
    "Agent（推荐用于无人值守执行）",
  "cli.auth.login.prompt.identity.agentDesc":
    "把令牌绑定到 Agent 身份 — CLI 将以该 Agent 身份运行（长效 API token）。",
  "cli.auth.login.prompt.identity.human": "我的账号（Human）",
  "cli.auth.login.prompt.identity.humanDesc":
    "把令牌绑定到当前人类审批者的账号 — 适合在终端中操作看板。",

  // bootstrap warnings / errors
  // Intentionally omitted from `zh` to exercise the English fallback
  // path in `i18n/index.test.ts` — bootstrap warnings are rare so they
  // ride the last-mile until the Chinese copy is finalised.

  // common
  "common.unnamed": "（未命名）",
  "common.yes": "是",
  "common.no": "否",
};
