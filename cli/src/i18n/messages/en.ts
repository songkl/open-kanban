// English message dictionary for the Open Kanban CLI.
//
// This is the source of truth for the default locale — the Chinese
// dictionary (`./zh.ts`) only needs to override the keys whose value
// genuinely differs in Chinese. Anything missing from `zh.ts` falls
// back to the English string here, so adding a new key requires only
// touching this file (and the type in `../index.ts` picks it up via
// `keyof typeof en`).

export const en = {
  // Top-level CLI
  "cli.description": "Open Kanban CLI - command-line client for the Open Kanban board",
  "cli.option.apiUrl": "Kanban API base URL",
  "cli.option.profile": "credential profile to use",
  "cli.option.output": "output format (table|json|yaml)",
  "cli.option.noColor": "disable ANSI color in table output",
  "cli.option.color": "force color on/off (on|off|auto)",
  "cli.option.lang": "override UI language (auto|en|zh); defaults to LANG env",

  // auth
  "cli.auth.description": "manage CLI authentication",
  "cli.auth.login.description":
    "authenticate the CLI. Default: start the OAuth 2.1 device authorization grant (browser-based). When run from a TTY with no explicit mode flag, interactively asks whether to bind to an Agent or to your own account (s-1246). Pass --as-human / --as-agent to skip the prompt. Shortcut: --user <username> --password <password> exchanges the legacy username/password login for a long-lived bearer token (s-1275) without opening a browser; --password-stdin reads the password from stdin instead of the command line.",
  "cli.auth.login.opt.asHuman":
    "bind the token to the human approver's account instead of the default Agent identity (s-1231)",
  "cli.auth.login.opt.asAgent":
    "explicitly bind the token to an Agent identity; skips the interactive identity picker when stdin is a TTY (s-1246)",
  "cli.auth.login.opt.noOpen":
    "do not launch the verification URL in the default browser (agent mode only)",
  "cli.auth.login.opt.user":
    "exchange username + password for a long-lived bearer token via POST /api/auth/login (s-1275); --password is also required. Cannot be combined with --as-human / --as-agent.",
  "cli.auth.login.opt.password":
    "password for --user (s-1275). Avoid shell history by piping: read -s PW && kanban auth login --user admin --password \"$PW\", or use --password-stdin / KANBAN_CLI_PASSWORD.",
  "cli.auth.login.opt.passwordStdin":
    "read the password from stdin (one line) instead of --password (s-1275)",
  "cli.auth.login.err.mixPasswordWithMode":
    "Cannot pass --user/--password together with --as-human / --as-agent; the password shortcut always binds to the username it was given.",
  "cli.auth.login.err.missingUser":
    "kanban auth login --user <username> --password <password>: --user is required",
  "cli.auth.login.err.mixAsHumanAsAgent":
    "Cannot pass both --as-human and --as-agent; pick one.",
  "cli.auth.status.description": "show current profile, host, scope, and token lifetime",
  "cli.auth.logout.description": "delete stored credentials",
  "cli.auth.whoami.description":
    "call GET /api/v1/users/me and show the current user",
  "cli.auth.whoami.opt.path": "override the whoami endpoint path",

  // auth agent
  "cli.auth.agent.description":
    "manage the Agent identity bound to the CLI (unattended / automation use)",
  "cli.auth.agent.list.description":
    "list configured Agents on the server (admin OAuth session required)",
  "cli.auth.agent.create.description":
    "create a new Agent on the server and bind its API token to the CLI profile (admin OAuth session required)",
  "cli.auth.agent.create.opt.avatar": "avatar URL for the new Agent",
  "cli.auth.agent.create.opt.role": "role for the new Agent (ADMIN|MEMBER|VIEWER)",
  "cli.auth.agent.create.opt.noBind":
    "do not persist the new token to the credential store (dry run)",
  "cli.auth.agent.create.err.invalidRole":
    "Invalid --role: {{value}}. Use one of ADMIN, MEMBER, VIEWER.",
  "cli.auth.agent.bind.description":
    "bind the CLI to an existing Agent API token (issued via the web UI or `kanban auth agent create`)",
  "cli.auth.agent.bind.opt.token":
    "Agent API token to persist (else KANBAN_AGENT_TOKEN, else prompt)",
  "cli.auth.agent.bind.prompt.token": "Agent API token:",
  "cli.auth.agent.bind.prompt.tokenRequired": "Token is required",
  "cli.auth.agent.login.description":
    "start the OAuth device flow and bind the CLI to an Agent identity chosen on the approval page",
  "cli.auth.agent.login.opt.noOpen":
    "do not launch the verification URL in the default browser",
  "cli.auth.agent.delete.description": "delete an Agent (admin OAuth session required)",

  // status / dashboard
  "cli.status.description":
    "probe the Kanban API and report latency / boardsCount / apiUrl",
  "cli.dashboard.description":
    "fetch GET /api/v1/dashboard/stats and print a tabular summary",

  // boards
  "cli.boards.description": "manage boards",
  "cli.boards.list.description": "list non-deleted boards (GET /api/v1/boards)",
  "cli.boards.list.opt.fields": "comma-separated list of fields to show",
  "cli.boards.get.description": "fetch a single board by id (GET /api/v1/boards/:id)",
  "cli.boards.get.opt.fields": "comma-separated list of fields to show",

  // columns
  "cli.columns.description": "manage columns",
  "cli.columns.list.description": "list columns (GET /api/v1/columns)",
  "cli.columns.list.opt.board": "filter by board id",
  "cli.columns.list.opt.positions":
    "comma-separated list of positions to include (e.g. 1,3,5)",
  "cli.columns.list.opt.fields": "comma-separated list of fields to show",
  "cli.columns.get.description": "fetch a single column by id (GET /api/v1/columns/:id)",
  "cli.columns.get.opt.fields": "comma-separated list of fields to show",

  // tasks
  "cli.tasks.description": "manage tasks",
  "cli.tasks.list.description":
    "list tasks (filters client-side over GET /api/v1/columns)",
  "cli.tasks.list.opt.board": "filter by board id",
  "cli.tasks.list.opt.column":
    "filter by column id (mutually exclusive with --status)",
  "cli.tasks.list.opt.status":
    "filter by status (todo|in_progress|review|done); mutually exclusive with --column",
  "cli.tasks.list.opt.agentType": "filter by column agentConfig.agentTypes",
  "cli.tasks.list.opt.priority": "filter by priority (low|medium|high)",
  "cli.tasks.list.opt.assignee": "filter by assignee username",
  "cli.tasks.list.opt.search": "free-text search across title and description",
  "cli.tasks.list.opt.since": "filter by creation date (today|thisWeek|thisMonth)",
  "cli.tasks.list.opt.tag": "filter by a meta value (substring match)",
  "cli.tasks.list.opt.lightweight":
    "return only id/title/priority/assignee/createdAt (default behaviour)",
  "cli.tasks.list.opt.fields": "field set for change-detection (id|id+updated)",
  "cli.tasks.list.err.invalidFields":
    "invalid --fields value: {{value}} (allowed: id, id+updated)",
  "cli.tasks.get.description": "fetch a single task by id (GET /api/v1/tasks/:id)",
  "cli.tasks.create.description": "create a task (POST /api/v1/tasks)",
  "cli.tasks.create.opt.title": "task title (required)",
  "cli.tasks.create.opt.description": "task description",
  "cli.tasks.create.opt.column":
    "target column id (mutually exclusive with --status)",
  "cli.tasks.create.opt.status":
    "target status (todo|in_progress|review|done); mutually exclusive with --column",
  "cli.tasks.create.opt.board": "default board for status→column resolution",
  "cli.tasks.create.opt.priority":
    "task priority (low|medium|high); defaults to medium",
  "cli.tasks.create.opt.assignee": "task assignee username",
  "cli.tasks.create.opt.meta":
    "metadata key=value pairs (repeatable or comma-separated)",
  "cli.tasks.create.opt.noPublish": "create as a draft instead of a published task",
  "cli.tasks.update.description": "update a task (PUT /api/v1/tasks/:id)",
  "cli.tasks.update.opt.title": "new title",
  "cli.tasks.update.opt.description": "new description",
  "cli.tasks.update.opt.priority": "new priority (low|medium|high)",
  "cli.tasks.update.opt.assignee": "new assignee username",
  "cli.tasks.update.opt.meta":
    "new metadata key=value pairs (repeatable or comma-separated)",
  "cli.tasks.update.opt.column":
    "move task to this column (mutually exclusive with --status)",
  "cli.tasks.update.opt.status":
    "move task to the column with this status (todo|in_progress|review|done); mutually exclusive with --column",
  "cli.tasks.delete.description":
    "delete a task (DELETE /api/v1/tasks/:id); --yes skips confirmation",
  "cli.tasks.delete.opt.yes": "skip confirmation prompt (default behaviour)",
  "cli.tasks.complete.description":
    "mark a task as complete by moving it to the board's done column (POST /api/v1/tasks/:id/complete)",
  "cli.tasks.advance.description":
    "advance a task one column forward (POST /api/v1/tasks/:id/advance)",
  "cli.tasks.move.description":
    "move a task to a target column or status (PUT /api/v1/tasks/:id with columnId)",
  "cli.tasks.move.opt.column":
    "target column id (mutually exclusive with --status)",
  "cli.tasks.move.opt.status":
    "target status (todo|in_progress|review|done); mutually exclusive with --column",

  // tasks batch
  "cli.tasks.batch.description": "batch task operations (create / update / delete)",
  "cli.tasks.batch.create.description":
    "create multiple tasks (POST /api/v1/tasks/batch); input from --file or repeated --title/--column flags",
  "cli.tasks.batch.create.opt.file":
    "read tasks from a JSON or YAML file (single object or array of objects)",
  "cli.tasks.batch.create.opt.title":
    "task title; repeat for multiple tasks",
  "cli.tasks.batch.create.opt.description": "task description",
  "cli.tasks.batch.create.opt.column": "target column id",
  "cli.tasks.batch.create.opt.status":
    "target status (todo|in_progress|review|done)",
  "cli.tasks.batch.create.opt.priority": "task priority (low|medium|high)",
  "cli.tasks.batch.create.opt.assignee": "task assignee username",
  "cli.tasks.batch.create.opt.published":
    "publish each task (default behaviour)",
  "cli.tasks.batch.update.description":
    "update multiple tasks (PUT /api/v1/tasks/batch) with the same column/status/priority/assignee",
  "cli.tasks.batch.update.opt.file":
    "read ids from a UTF-8 text file (one id per line, # comments allowed)",
  "cli.tasks.batch.update.opt.column":
    "move tasks to this column (mutually exclusive with --status)",
  "cli.tasks.batch.update.opt.status":
    "move tasks to the column with this status (todo|in_progress|review|done); mutually exclusive with --column",
  "cli.tasks.batch.update.opt.priority": "new priority (low|medium|high)",
  "cli.tasks.batch.update.opt.assignee": "new assignee username",
  "cli.tasks.batch.delete.description":
    "delete multiple tasks (DELETE /api/v1/tasks/batch); --yes is the default and can be omitted",
  "cli.tasks.batch.delete.opt.file":
    "read ids from a UTF-8 text file (one id per line, # comments allowed)",
  "cli.tasks.batch.delete.opt.yes":
    "skip confirmation prompt (default behaviour)",
  "cli.tasks.batch.err.invalidBoolean":
    "invalid boolean value: {{value}} (allowed: true|false)",

  // drafts
  "cli.drafts.description": "manage draft tasks",
  "cli.drafts.list.description": "list draft tasks (GET /api/v1/drafts)",
  "cli.drafts.list.opt.board": "filter by board id",
  "cli.drafts.publish.description":
    "publish a draft task (POST /api/v1/drafts/:id/publish)",
  "cli.drafts.unpublish.description":
    "unpublish a task (POST /api/v1/drafts/:id/unpublish)",

  // archived
  "cli.archived.description": "manage archived tasks",
  "cli.archived.list.description": "list archived tasks (GET /api/v1/archived)",
  "cli.archived.archive.description": "archive a task (POST /api/v1/archived/:id)",
  "cli.archived.restore.description": "restore an archived task (POST /api/v1/archived/:id/restore)",

  // comments
  "cli.comments.description": "manage task comments",
  "cli.comments.add.description": "add a comment to a task",
  "cli.comments.add.opt.body": "comment body (else read from stdin)",
  "cli.comments.add.opt.author":
    "optional author override (server uses authenticated user by default)",
  "cli.comments.list.description": "list comments for a task",

  // subtasks
  "cli.subtasks.description": "manage task subtasks",
  "cli.subtasks.list.description": "list subtasks for a task",
  "cli.subtasks.create.description": "create a subtask on a task",
  "cli.subtasks.create.opt.title": "subtask title",
  "cli.subtasks.update.description":
    "update a subtask (PUT /api/v1/subtasks/:id); pass --title and/or --completed/--no-completed",
  "cli.subtasks.update.opt.title": "new subtask title",
  "cli.subtasks.update.opt.completed":
    "mark the subtask as completed (use --no-completed to mark as incomplete)",
  "cli.subtasks.delete.description": "delete a subtask",

  // mine
  "cli.mine.description": "list tasks assigned to the current user / Agent",
  "cli.mine.opt.board": "filter by board id",
  "cli.mine.opt.column": "filter by column id",
  "cli.mine.opt.status": "filter by status",
  "cli.mine.opt.priority": "filter by priority (low|medium|high)",
  "cli.mine.opt.tag": "filter by a meta tag",
  "cli.mine.opt.limit": "maximum number of tasks to return",

  // run / runs
  "cli.run.description": "run the runner loop (start) or scaffold its config (init)",
  "cli.run.start.description":
    "start the runner loop (claim → spawn agent → heartbeat → finish)",
  "cli.run.opt.config":
    "explicit path to a .kanban-runner{.local}.yaml; overrides the discovery walk-up",
  "cli.run.opt.board":
    "mode-1 board id to watch (must pair with --status)",
  "cli.run.opt.status":
    "mode-1 column status to watch (todo|in_progress|review|done); must pair with --board",
  "cli.run.opt.mine":
    "mode-2: pick tasks assigned to (or routed to) the authenticated agent",
  "cli.run.opt.once":
    "process a single task and exit; useful for cron / smoke tests",
  "cli.run.opt.debug":
    "emit verbose trace logs to stderr (claim attempts, polling delays, spawn details, hydration, results)",
  "cli.run-init.description":
    "interactively create a .kanban-runner{.local}.yaml (mode, agent, runner)",
  "cli.runs.description": "manage persisted runs (started via `kanban run`)",
  "cli.runs.list.description":
    "list past task runs (auth required); supports --runner-id, --since, --status, --task, --board, --limit, --offset",
  "cli.runs.list.opt.runnerId":
    "filter by exact runner identifier (forwards to ?runnerId=)",
  "cli.runs.list.opt.since":
    "lower bound on finished_at; accepts relative durations like 1d/2h/30m or an absolute RFC3339/YYYY-MM-DD timestamp",
  "cli.runs.list.opt.status":
    "filter by terminal status (completed|failed|released)",
  "cli.runs.list.opt.task": "filter by task id (forwards to ?taskId=)",
  "cli.runs.list.opt.board": "filter by board id (forwards to ?boardId=)",
  "cli.runs.list.opt.limit":
    "pagination size; server defaults to 50, capped at 200",
  "cli.runs.list.opt.offset": "pagination offset",
  "cli.runs.cancel.description": "cancel a persisted run",
  "cli.runs.err.invalidLimit":
    "invalid --limit value: {{value}} (must be an integer)",
  "cli.runs.err.invalidOffset":
    "invalid --offset value: {{value}} (must be a non-negative integer)",
  "cli.attach.description":
    "attach the calling runner to a specific task by id (POST /api/v1/runs/:taskId/attach); AI-first entry point that does not require owning the surrounding column",
  "cli.attach.opt.runnerId":
    "stable runner identity (defaults to <host>-<pid>-<uuid>); used by heartbeat/finish to verify ownership",
  "cli.attach.opt.agentType":
    "agent class the runner is willing to pick up; defaults to KANBAN_RUNNER_AGENT_TYPE or 'opencode'",
  "cli.attach.opt.lockTimeoutMs":
    "lock TTL in milliseconds (defaults to server's DefaultRunLockTimeoutMs)",
  "cli.attach.opt.reason":
    "free-form note attached to the audit activity so the operator can tell apart manual escalation from a scanner grab",
  "cli.attach.err.invalidLockTimeout":
    "invalid --lock-timeout-ms value: {{value}} (must be a positive integer)",

  // workspace
  "cli.workspace.description": "manage workspace files",
  "cli.workspace.upload.description":
    "upload a local text file to the workspace (POST /api/v1/workspace/upload)",
  "cli.workspace.upload.opt.path":
    "workspace-relative path for the uploaded file (defaults to the local basename)",
  "cli.workspace.batch.description":
    "upload multiple local text files in one request (POST /api/v1/workspace/batch-upload)",
  "cli.workspace.list.description":
    "list workspace files (GET /api/v1/workspace/files)",
  "cli.workspace.list.opt.path":
    "filter to a workspace-relative subdirectory",
  "cli.workspace.read.description":
    "read a workspace file (GET /api/v1/workspace/files/<id>); default writes the raw content to stdout, --output json emits a base64 payload",
  "cli.workspace.delete.description":
    "delete a workspace file (DELETE /api/v1/workspace/files/<id>); --yes is the default",
  "cli.workspace.stats.description":
    "show workspace stats (GET /api/v1/workspace/stats)",

  // shell
  "cli.shell.description":
    "start an interactive REPL; type `exit` (or Ctrl-D) to leave",

  // completion
  "cli.completion.description":
    "emit a shell completion script (bash|zsh|fish)",
  "cli.completion.bash.description":
    "emit a bash completion script to stdout",
  "cli.completion.zsh.description":
    "emit a zsh completion script to stdout",
  "cli.completion.fish.description":
    "emit a fish completion script to stdout",
  "cli.complete.description":
    "internal: dynamic completion used by the shell scripts",
  "cli.complete.err.unsupportedShell":
    "shell not supported by the completion generator (tried: bash, zsh, fish, pwsh)",

  // config
  "cli.config.description":
    "view or update CLI configuration (API URL, profile, output, timeout)",
  "cli.config.get.description":
    "print the effective value for <key> (apiUrl|output|profile|timeout); with no key, prints every supported key alongside its source",
  "cli.config.set.description":
    "write <key>=<value> to ~/.config/kanban-cli/config.json; supported keys: apiUrl, output, profile, timeout",
  "cli.config.err.invalidKey":
    "invalid config key: {{value}} (supported: apiUrl, output, profile, timeout)",
  "cli.config.err.invalidOutput":
    "invalid --output: {{value}} (allowed: table|json|yaml)",
  "cli.config.err.invalidTimeout":
    "invalid --timeout: {{value}} (must be a positive number of seconds)",

  // agent
  "cli.agent.description": "manage Agents on the server",
  "cli.agent.list.description": "list configured Agents",
  "cli.agent.create.description": "create a new Agent on the server",
  "cli.agent.create.opt.nickname": "Agent nickname",
  "cli.agent.create.opt.avatar": "Agent avatar URL",
  "cli.agent.create.opt.role": "Agent role (ADMIN|MEMBER|VIEWER)",
  "cli.agent.bind.description": "bind the CLI to an Agent API token",
  "cli.agent.login.description": "log in via the OAuth device flow",
  "cli.agent.delete.description": "delete an Agent",

  // login mode picker prompt
  "cli.auth.login.prompt.identity": "Bind this CLI to which identity?",
  "cli.auth.login.prompt.identity.agent":
    "Agent (recommended for unattended runners)",
  "cli.auth.login.prompt.identity.agentDesc":
    "Bind the token to an Agent identity — the CLI will run as that Agent (long-lived API token).",
  "cli.auth.login.prompt.identity.human": "My account (Human)",
  "cli.auth.login.prompt.identity.humanDesc":
    "Bind the token to the human approver's account — useful when driving the dashboard from the terminal.",

  // bootstrap warnings / errors
  "cli.bootstrap.warning.configResolve":
    "failed to resolve config ({{reason}}); falling back to built-in defaults",

  // common
  "common.unnamed": "(unnamed)",
  "common.yes": "yes",
  "common.no": "no",
};

export type EnglishMessageKey = keyof typeof en;
