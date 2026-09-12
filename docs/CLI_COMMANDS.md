# Kanban CLI — Command Reference

This document is the detailed flag-level reference for every command exposed
by the `kanban` binary. For an end-to-end onboarding flow, configuration
overview, troubleshooting, and exit-code table, see [`cli/README.md`](../cli/README.md).

> Source of truth: [`cli/src/program.ts`](../cli/src/program.ts) and the
> per-command modules under [`cli/src/commands/`](../cli/src/commands/).
> If you spot a discrepancy, the source wins.

## Conventions

- All commands accept the global flags described in [§ Global flags](#global-flags).
- `--flag <value>` is required-typed, `--flag` is a boolean.
- "Mutually exclusive" means passing both raises `InvalidUsageError` (exit code 1)
  *before* any network traffic — typos fail fast.
- Square brackets around a positional (`[key]`) denote an optional argument.
- `<ids...>` denotes a variadic list (one or more).
- `--output json` produces machine-readable JSON for every command. The default
  is `table` (ANSI-colored when stdout is a TTY).
- `--color` / `--no-color` control ANSI color in tables.

## Global flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--api-url <url>` | string | built-in `http://localhost:8080` | Kanban API base URL. Override per-invocation; otherwise resolved from `KANBAN_API_URL` env → `~/.config/kanban-cli/config.json` → built-in. |
| `--profile <name>` | string | _(unset)_ | Credential profile name. Lets you keep multiple accounts (e.g. `work` vs `personal`) side-by-side without overwriting each other. |
| `--output <format>` | string | `table` | Output renderer: `table` or `json`. (`yaml` is accepted by the flag but is rendered as `table` until a YAML formatter is added.) |
| `--no-color` | boolean | `false` | Disable ANSI color in table output. Equivalent to `--color=off`. |
| `--color <mode>` | string | `auto` | Force color: `on` / `off` / `auto`. `auto` honours `NO_COLOR` / `FORCE_COLOR` / TTY detection. |

Priority chain for the resolved API URL: **CLI flag > environment variable
(`KANBAN_API_URL`) > config file (`~/.config/kanban-cli/config.json`) >
built-in default**. Run `kanban config get apiUrl` to inspect the chain.

---

## Table of contents

- [Global flags](#global-flags)
- [`auth` — authentication](#auth--authentication)
- [`status` — API probe](#status--api-probe)
- [`dashboard` — workspace stats](#dashboard--workspace-stats)
- [`boards` — board navigation](#boards--board-navigation)
- [`columns` — column navigation](#columns--column-navigation)
- [`tasks` — task CRUD](#tasks--task-crud)
- [`tasks batch` — bulk operations](#tasks-batch--bulk-operations)
- [`drafts` — draft tasks](#drafts--draft-tasks)
- [`archived` — archived tasks](#archived--archived-tasks)
- [`comments` — task comments](#comments--task-comments)
- [`subtasks` — task subtasks](#subtasks--task-subtasks)
- [`mine` — current-agent tasks](#mine--current-agent-tasks)
- [`workspace` — workspace files](#workspace--workspace-files)
- [`shell` — interactive REPL](#shell--interactive-repl)
- [`completion` — shell completion](#completion--shell-completion)
- [`config` — view / update settings](#config--view--update-settings)

---

## `auth` — authentication

Group description: _manage CLI authentication_.

Auth commands do not accept any per-subcommand flags beyond the inherited
global flags. Tokens are stored at
`$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode `0600`).
Access tokens are refreshed automatically before each request.

### `auth login`

```
kanban auth login
```

Start the OAuth 2.1 device authorization grant and persist credentials.
On success the CLI prints a verification URL + user code to **stderr**:

```
Open Kanban authorization required
  Visit:  http://localhost:8080/oauth/device
  Code:   HSXL-KQPR
  Scope:  kanban:read tasks:write
  Waiting for approval (expires in 600s)...
```

Flow:

1. `GET /.well-known/oauth-authorization-server` — discover endpoints
2. `POST /oauth/register` — dynamic client registration (RFC 7591, public client)
3. `POST /oauth/device/code` — request a device code
4. Poll `/oauth/token` until approval / expiry
5. Encrypt and persist the token to disk (mode `0600`)
6. Auto-refresh via `refresh_token` grant on subsequent runs

Exit codes: `0` on success, `3` on user denial / expiry, `6` on network error.

### `auth status`

```
kanban auth status
```

Print the active profile, host, client ID, scope, and access-token lifetime.

### `auth logout`

```
kanban auth logout
```

Delete the stored credentials. Idempotent — if no credentials exist it prints
`No credentials found; nothing to do.` to stdout and exits `0`.

### `auth whoami`

```
kanban auth whoami [--path <path>]
```

Call `GET <path>` (default `/api/v1/users/me`) and print the resolved user.
Useful for verifying the OAuth session is bound to the expected account.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--path <path>` | string | `/api/v1/users/me` | Override the endpoint path (e.g. for custom auth proxies). |

---

## `status` — API probe

```
kanban status
```

Probe the Kanban API and print a tabular reachability report. **Does not
require authentication.** Network failures do not throw — the report just
marks the API as `offline` and writes a red error line to stderr.

```bash
$ kanban status
Kanban API   http://localhost:8080
Status       online
Latency      42 ms
Boards       3
Timestamp    2026-09-12T04:00:00Z

  ID                                   NAME
  ──────────────────────────────────── ────────────────────────────
  board-1                              Engineering
  board-2                              Design
  board-3                              Operations
```

---

## `dashboard` — workspace stats

```
kanban dashboard
```

Fetch `GET /api/v1/dashboard/stats` and print a tabular summary
(totals, per-status, per-priority). **Auth required.**

If credentials are missing, prints `Not logged in. Run 'kanban auth login' first.`
to stderr and exits with code `2`.

---

## `boards` — board navigation

Group description: _manage boards_. Read-only; endpoints are public.

### `boards list`

```
kanban boards list [--fields <fields>]
```

Fetch `GET /api/v1/boards` (non-deleted boards only).

| Flag | Type | Default | Description |
|---|---|---|---|
| `--fields <fields>` | string[] | `id,name,createdAt` | Comma-separated projection. Allowed: `id`, `name`, `description`, `shortAlias`, `createdAt`, `updatedAt`, `columnCount`. Unknown fields are silently dropped. |

```bash
$ kanban boards list --fields id,name,columnCount
ID          NAME            COLUMNS
──────────  ──────────────  ───────
board-1     Engineering     4
board-2     Design          3
```

### `boards get <id>`

```
kanban boards get <id> [--fields <fields>]
```

Fetch `GET /api/v1/boards/:id`. Empty / whitespace `id` raises `InvalidUsageError`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--fields <fields>` | string[] | `id,name,description,shortAlias,createdAt,updatedAt,columnCount` | Same allowed values as `boards list`. |

---

## `columns` — column navigation

Group description: _manage columns_. Read-only; endpoints are public.

### `columns list`

```
kanban columns list [--board <id>] [--positions <list>] [--fields <fields>]
```

Fetch `GET /api/v1/columns` (optionally filtered server-side).

| Flag | Type | Default | Description |
|---|---|---|---|
| `--board <id>` | string | _(all boards)_ | Filter by board id (sent as `?boardId=`). |
| `--positions <list>` | number[] | _(all positions)_ | Comma-separated positions to include (e.g. `1,3,5`). Non-numeric tokens are silently filtered. |
| `--fields <fields>` | string[] | `id,name,boardId,position,status` | Comma-separated projection. Allowed: `id`, `name`, `boardId`, `position`, `status`, `color`, `description`, `ownerAgentId`, `createdAt`, `updatedAt`. |

```bash
$ kanban columns list --board board-1 --positions 1,2 --fields id,name,status
ID          NAME      STATUS
──────────  ───────── ──────────
col-todo    Todo      todo
col-doing   Doing     in_progress
```

### `columns get <id>`

```
kanban columns get <id> [--fields <fields>]
```

Fetch `GET /api/v1/columns/:id`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--fields <fields>` | string[] | `id,name,boardId,position,status,color,description` | Same allowed values as `columns list`. |

---

## `tasks` — task CRUD

Group description: _manage tasks_. `list` and `get` are public; the rest are auth-required.

### `tasks list`

```
kanban tasks list [--board <id>] [--column <id>|--status <s>]
                  [--agent-type <type>] [--priority <p>] [--assignee <u>]
                  [--search <q>] [--since <range>] [--tag <tag>]
                  [--lightweight] [--fields <set>]
```

List tasks. Filters are applied **client-side** over `GET /api/v1/columns`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--board <id>` | string | _(all boards)_ | Filter by board id. |
| `--column <id>` | string | _(all columns)_ | Mutually exclusive with `--status`. |
| `--status <status>` | enum | _(all statuses)_ | Mutually exclusive with `--column`. Allowed: `todo` / `in_progress` / `review` / `done`. |
| `--agent-type <type>` | string | _(none)_ | Case-insensitive match against the column's `agentConfig.agentTypes`. |
| `--priority <priority>` | enum | _(all)_ | Allowed: `low` / `medium` / `high`. |
| `--assignee <username>` | string | _(all)_ | Exact match. |
| `--search <query>` | string | _(none)_ | Case-insensitive substring match across `title` and `description`. |
| `--since <range>` | enum | _(none)_ | Allowed: `today` / `thisWeek` / `thisMonth`. |
| `--tag <tag>` | string | _(none)_ | Case-insensitive substring match against any value in `meta`. |
| `--lightweight` | boolean | `false` | Documented as returning `id/title/priority/assignee/createdAt`; today the default projection already is that set, so the flag is currently a no-op. |
| `--fields <set>` | enum | `default` | Change-detection field set: `id` or `id+updated`. Anything else raises `InvalidUsageError`. |

```bash
$ kanban tasks list --status in_progress --priority high
$ kanban tasks list --assignee alice --since thisWeek
$ kanban tasks list --search "OAuth" --tag security
```

### `tasks get <id>`

```
kanban tasks get <id>
```

Fetch `GET /api/v1/tasks/:id`. Public — does not require auth.

### `tasks create`

```
kanban tasks create --title <t> [--description <d>]
                    [--column <id>|--status <s>] [--board <id>]
                    [--priority <p>] [--assignee <u>]
                    [--meta <kv>...] [--no-publish]
```

Create a task (`POST /api/v1/tasks`). **Auth required.**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--title <title>` | string | **YES** | — | Task title. |
| `--description <description>` | string | no | _(empty)_ | Task description. |
| `--column <id>` | string | no | _(status-resolved)_ | Target column id. Mutually exclusive with `--status`. |
| `--status <status>` | enum | no | _(column-resolved)_ | Target status (`todo`/`in_progress`/`review`/`done`). Mutually exclusive with `--column`. |
| `--board <id>` | string | no | _(any)_ | Scope for status→column resolution. |
| `--priority <priority>` | enum | no | `medium` | `low` / `medium` / `high`. |
| `--assignee <username>` | string | no | _(none)_ | Assignee. |
| `--meta <kv...>` | string[] | no | `{}` | Metadata key=value pairs. Repeatable, or comma-separated inside one token (e.g. `--meta k1=v1,k2=v2`). |
| `--no-publish` | boolean | no | `published=true` | Negation: passing `--no-publish` creates a draft instead. |

Target column resolution order: explicit `--column` → `--status` mapped to a
Chinese column name within `--board` (then any board) → first column of
`--board` → first column globally.

```bash
# Create on the default column with a high priority
$ kanban tasks create --title "Ship docs" --priority high

# Create on the in_progress column of a specific board
$ kanban tasks create --title "Refactor auth" \
    --board board-1 --status in_progress --assignee alice

# Create a draft with metadata
$ kanban tasks create --title "Idea: dark mode" --no-publish \
    --meta tag=ux,priority=p3
```

### `tasks update <id>`

```
kanban tasks update <id> [--title <t>] [--description <d>]
                        [--priority <p>] [--assignee <u>] [--meta <kv>...]
                        [--column <id>|--status <s>]
```

Update a task (`PUT /api/v1/tasks/:id`). **Auth required.** At least one of
`--title / --description / --priority / --assignee / --meta / --column / --status`
is required.

| Flag | Type | Description |
|---|---|---|
| `--title <title>` | string | New title. |
| `--description <description>` | string | New description. |
| `--priority <priority>` | enum | New priority (`low` / `medium` / `high`). |
| `--assignee <username>` | string | New assignee. |
| `--meta <kv...>` | string[] | New metadata. Same parsing as `tasks create`. |
| `--column <id>` | string | Move to this column. Mutually exclusive with `--status`. |
| `--status <status>` | enum | Move to the column with this status. Mutually exclusive with `--column`. |

### `tasks delete <id>`

```
kanban tasks delete <id> [--yes]
```

Delete a task (`DELETE /api/v1/tasks/:id`). **Auth required.** The `--yes`
flag exists for symmetry with other destructive commands — confirmation is
always skipped in current handlers.

| Flag | Type | Description |
|---|---|---|
| `--yes` | boolean | Skip confirmation prompt (no-op — confirmation is always skipped). |

### `tasks complete <id>`

```
kanban tasks complete <id>
```

Advance a task to the next column (`POST /api/v1/tasks/:id/complete`).
**Auth required.** No flags.

### `tasks move <id>`

```
kanban tasks move <id> [--column <id>|--status <s>]
```

Move a task to a target column or status. **Auth required.** Exactly one of
`--column` / `--status` is required.

| Flag | Type | Required | Description |
|---|---|---|---|
| `--column <id>` | string | one-of | Target column id. Mutually exclusive with `--status`. |
| `--status <status>` | enum | one-of | Target status (`todo` / `in_progress` / `review` / `done`). Mutually exclusive with `--column`. |

---

## `tasks batch` — bulk operations

Group description: _batch task operations (create / update / delete)_.
All subcommands are **auth-required**.

### `tasks batch create`

```
kanban tasks batch create
                       [--file <path>]
                       [--title <t>...] [--description <d>...]
                       [--column <id>...] [--status <s>...]
                       [--priority <p>...] [--assignee <u>...]
                       [--published <bool>...]
```

Create multiple tasks (`POST /api/v1/tasks/batch`). Input comes from
`--file` (JSON or YAML) **or** repeated `--title` / `--column` / etc. flags
aligned positionally.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--file <path>` | string | _(none)_ | Read tasks from JSON or YAML. A single object or an array of objects is fine. JSON is detected first (file starts with `{` or `[`). |
| `--title <title>` | string[] | — | Repeat per task. Tokens collected by `splitFlagValues`. |
| `--description <description>` | string[] | — | Repeat per task. |
| `--column <id>` | string[] | — | Repeat per task. |
| `--status <status>` | string[] | — | Repeat per task. |
| `--priority <priority>` | string[] | — | Repeat per task. |
| `--assignee <username>` | string[] | — | Repeat per task. |
| `--published` | boolean[] | — | Publish flag per task. Accepted: `true` / `false` / `1` / `0` / `yes` / `no` (case-insensitive). |

When `--file` is supplied, all repeated flags are ignored. Without `--file`,
the longest list dictates the number of tasks; missing fields fall back to
`undefined`. Each task must have a non-empty `title` (else
`InvalidUsageError`). Default priority `medium`, default published `true`.

```bash
# Create from a YAML file
$ kanban tasks batch create --file ./tasks.yaml

# Create from repeated flags
$ kanban tasks batch create \
    --title "Write spec"   --column col-todo  --priority high \
    --title "Implement X"  --column col-doing --priority medium

# Create with mixed publish state
$ kanban tasks batch create --title "Draft A" --no-publish --title "Live B"
```

#### File format

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

Each entry must include a non-empty `title`; `columnId`, `priority`, `status`,
`description`, `assignee`, `published`, and `meta` are optional. An unknown
status or priority raises `InvalidUsageError` before any HTTP traffic.

### `tasks batch update <ids...>`

```
kanban tasks batch update <ids...> [--file <path>]
                                  [--column <id>|--status <s>]
                                  [--priority <p>] [--assignee <u>]
```

Update multiple tasks (`PUT /api/v1/tasks/batch`) with the same patch.
Ids come from positionals **or** `--file` (UTF-8 text, one id per line,
`#` comments allowed). At least one of `--column / --status / --priority / --assignee`
is required.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--file <path>` | string | _(none)_ | Read ids from a UTF-8 text file (one per line; `#` comments and blank lines skipped). File ids are appended to positional ids. |
| `--column <id>` | string | _(none)_ | Move tasks to this column. Mutually exclusive with `--status`. |
| `--status <status>` | enum | _(none)_ | Move tasks to the column with this status. Mutually exclusive with `--column`. |
| `--priority <priority>` | enum | _(none)_ | New priority. |
| `--assignee <username>` | string | _(none)_ | New assignee. |

```bash
$ kanban tasks batch update t1 t2 t3 --status done
$ kanban tasks batch update --file ./ids.txt --priority low --assignee alice
```

### `tasks batch delete <ids...>`

```
kanban tasks batch delete <ids...> [--file <path>] [--yes]
```

Delete multiple tasks (`DELETE /api/v1/tasks/batch`). Ids come from
positionals **or** `--file`. `--yes` exists for symmetry — confirmation is
always skipped.

| Flag | Type | Description |
|---|---|---|
| `--file <path>` | string | Same id-file format as `tasks batch update`. |
| `--yes` | boolean | Skip confirmation (no-op — confirmation is always skipped). |

```bash
$ kanban tasks batch delete t1 t2 t3
$ kanban tasks batch delete --file ./ids.txt
```

---

## `drafts` — draft tasks

Group description: _manage draft tasks_. **Auth required.**

### `drafts list`

```
kanban drafts list [--board <id>]
```

Fetch `GET /api/v1/drafts`. Whitespace-only `--board` is silently ignored.

### `drafts publish <id>`

```
kanban drafts publish <id>
```

Publish a draft task (`PUT /api/v1/tasks/:id` with `{ published: true }`).

### `drafts unpublish <id>`

```
kanban drafts unpublish <id>
```

Move a task back into drafts (`PUT /api/v1/tasks/:id` with `{ published: false }`).

---

## `archived` — archived tasks

Group description: _manage archived tasks_. **Auth required.**

### `archived list`

```
kanban archived list [--board <id>]
```

Fetch `GET /api/v1/archived`. Whitespace-only `--board` is silently ignored.

### `archived archive <id>`

```
kanban archived archive <id> [--yes]
```

Archive a task (`POST /api/v1/tasks/:id/archive` with `{ archived: true }`).
`--yes` is the default (no-op).

### `archived restore <id>`

```
kanban archived restore <id>
```

Restore an archived task (`POST /api/v1/tasks/:id/archive` with `{ archived: false }`).

---

## `comments` — task comments

Group description: _manage task comments_. **Auth required.**

### `comments add <taskId>`

```
kanban comments add <taskId> --body <text> [--author <name>]
```

Add a comment to a task (`POST /api/v1/comments`).

| Flag | Type | Required | Description |
|---|---|---|---|
| `--body <text>` | string | **YES** | Comment body. Pass `-` (the `STDIN_BODY_SENTINEL`) to slurp the body from stdin (UTF-8, trimmed; internal newlines preserved). Empty / whitespace raises `InvalidUsageError`. |
| `--author <name>` | string | no | Author override; the server uses the authenticated user by default. Empty / whitespace is dropped. |

```bash
# Inline body
$ kanban comments add task-123 --body "LGTM, ship it"

# Multi-line body from stdin
$ echo "Reviewed the OAuth flow.
Looks good. Suggest bumping the refresh interval." \
    | kanban comments add task-123 --body -

# From a file
$ kanban comments add task-123 --body "$(cat review.md)"
```

### `comments list <taskId>`

```
kanban comments list <taskId>
```

Fetch `GET /api/v1/comments?taskId=<id>`. Comments are returned ordered by
`createdAt` ascending (oldest first).

---

## `subtasks` — task subtasks

Group description: _manage task subtasks_. **Auth required.**

### `subtasks list <taskId>`

```
kanban subtasks list <taskId>
```

Fetch `GET /api/v1/subtasks?taskId=<id>`.

### `subtasks create <taskId>`

```
kanban subtasks create <taskId> --title <t>
```

Create a subtask (`POST /api/v1/subtasks`). Empty / whitespace title raises
`InvalidUsageError`.

### `subtasks update <id>`

```
kanban subtasks update <id> [--title <t>] [--completed|--no-completed]
```

Update a subtask (`PUT /api/v1/subtasks/:id`). At least one of `--title` /
`--completed` / `--no-completed` is required.

| Flag | Type | Description |
|---|---|---|
| `--title <title>` | string | New title. Empty / whitespace raises `InvalidUsageError`. |
| `--completed` | boolean | Mark subtask completed. |
| `--no-completed` | boolean | Mark subtask incomplete. |

### `subtasks delete <id>`

```
kanban subtasks delete <id> [--yes]
```

Delete a subtask (`DELETE /api/v1/subtasks/:id`). `--yes` is the default.

---

## `mine` — current-agent tasks

```
kanban mine [--board <id>] [--lightweight]
```

Fetch `GET /api/v1/mcp/my-tasks` and list tasks assigned to (or routed to)
the current agent. **Auth required.**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--board <id>` | string | _(none)_ | Forward-compatibility shim. The endpoint does not accept `boardId`, so the flag is currently **ignored** — a yellow warning is written to stderr when supplied. |
| `--lightweight` | boolean | `false` | When set, returns `id/title/priority/assignee/createdAt`. Otherwise `columnName` is included instead of `columnId`. |

---

## `workspace` — workspace files

Group description: _manage workspace files_. **Auth required.**

### `workspace upload <file>`

```
kanban workspace upload <file> [--path <remotePath>]
```

Upload a local text file (`POST /api/v1/workspace/upload`). The file is read
as UTF-8. Missing files (`ENOENT`) raise `InvalidUsageError`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--path <remotePath>` | string | local basename | Workspace-relative target path. Empty / whitespace raises `InvalidUsageError`. |

### `workspace batch-upload <files...>`

```
kanban workspace batch-upload <files...>
```

Upload multiple files in one request (`POST /api/v1/workspace/batch-upload`).
Each file's basename is used as the workspace path. Files are read in parallel.

### `workspace list`

```
kanban workspace list [--path <sub>]
```

List workspace files (`GET /api/v1/workspace/files`).

| Flag | Type | Default | Description |
|---|---|---|---|
| `--path <sub>` | string | _(all files)_ | Workspace-relative subdirectory filter (sent as `?path=`). |

### `workspace read <id>`

```
kanban workspace read <id>
```

Read a workspace file (`GET /api/v1/workspace/files/<id>`). The positional
`<id>` is the workspace-relative path. Default output writes the raw content
to stdout (pipable; a trailing newline is appended if missing). With
`--output json` the content is base64-encoded so binary payloads survive a
JSON round trip.

### `workspace delete <id>`

```
kanban workspace delete <id> [--yes]
```

Delete a workspace file (`DELETE /api/v1/workspace/files/<id>`). `--yes` is
the default.

### `workspace stats`

```
kanban workspace stats
```

Show `totalFiles / totalSize / fileCount / directoryCount` from
`GET /api/v1/workspace/stats`.

---

## `shell` — interactive REPL

```
kanban shell
```

Start an interactive REPL. The prompt is `kanban> `. Type `exit` or
`quit` to leave; <kbd>Ctrl-D</kbd> also works. On entry the REPL runs
`auth status`; if credentials are missing it prints a yellow warning
(`Not logged in. Run auth login first.`) to stderr but stays open.

Built-in shell commands:

| Command | Description |
|---|---|
| `help` | Print REPL help. |
| `exit` / `quit` | Close the REPL. |
| `clear` | Clear the screen (`\u001b[2J\u001b[H`). No-op when piped. |
| `whoami` | Call `GET /api/v1/users/me` (equivalent to `auth whoami`). |

Anything else is dispatched to a fresh `program.parseAsync(...)`, so the
full CLI is available inside the REPL. The REPL monkey-patches `process.exit`
so commands that call `process.exit(N)` (e.g. `auth status` when not logged
in) do not terminate the shell — the code is captured but ignored.

History is persisted to `~/.kanban_shell_history` (override via
`KANBAN_SHELL_HISTORY`). Tab completion covers top-level commands +
global flags.

---

## `completion` — shell completion

```
kanban completion bash
kanban completion zsh
kanban completion fish
```

Emit a self-contained completion script to stdout. Static suggestions
(subcommands, flags, allowed values for `--output`, `--color`, `--priority`,
`--status`, `--since`, `--fields`) are baked into the script so completion
works even when the API is unreachable. Dynamic values (board / column /
task / subtask / workspace ids) are fetched lazily through
`kanban __complete <line>` whenever you press <kbd>Tab</kbd>.

Install hints are printed to stderr.

```bash
# bash — system-wide (requires bash-completion)
$ kanban completion bash | sudo tee /etc/bash_completion.d/kanban

# bash — per-user
$ kanban completion bash > ~/.kanban-completion.bash
$ echo 'source ~/.kanban-completion.bash' >> ~/.bashrc

# zsh — drop the file on $fpath
$ kanban completion zsh > "${fpath[1]}/_kanban"
$ autoload -Uz compinit && compinit

# fish — current session / persistent
$ kanban completion fish | source
$ kanban completion fish > ~/.config/fish/completions/kanban.fish
```

The hidden `__complete <line> [point]` subcommand is used internally by the
scripts to resolve dynamic ids. It is not surfaced by `--help`.

---

## `config` — view / update settings

Group description: _view or update CLI configuration (API URL, profile, output, timeout)_.
The priority chain is implemented in [`cli/src/commands/config.ts`](../cli/src/commands/config.ts).

### `config get [key]`

```
kanban config get [key]
```

Print the effective value for `<key>` alongside its source.
Supported keys: `apiUrl`, `output`, `profile`, `timeout`.
Sources: `cli` (flag) > `env` > `file` > `default`.

- **With a key:** prints `value (source)` (or `<unset>` when no value resolves).
- **Without a key:** prints the config-file path and then one line per supported key.

```bash
$ kanban config get
config file: ~/.config/kanban-cli/config.json
apiUrl=http://localhost:8080 (default)
output=table (default)
profile=<unset> (default)
timeout=30000 (default)

$ kanban config get apiUrl
http://localhost:8080 (default)

$ KANBAN_API_URL=https://kanban.example.com kanban config get apiUrl
https://kanban.example.com (env)
```

### `config set <key> <value>`

```
kanban config set <key> <value>
```

Write `<key>=<value>` to `~/.config/kanban-cli/config.json` (mode `0600`).
Prints `set key=value` to stdout and `saved to <path>` to stderr.
Unknown keys raise `InvalidConfigKeyError`; bad values (e.g. non-integer
`timeout`, or `output` outside `table|json|yaml`) raise `InvalidConfigValueError`.
Both map to exit code `1`.

| Key | Accepted values |
|---|---|
| `apiUrl` | any URL string |
| `output` | `table` \| `json` \| `yaml` |
| `profile` | any string (empty string clears the active profile) |
| `timeout` | positive integer (milliseconds) |

```bash
$ kanban config set apiUrl https://kanban.example.com
set apiUrl=https://kanban.example.com
saved to ~/.config/kanban-cli/config.json

$ kanban config set output json
$ kanban config set timeout 60000
$ kanban config set profile work
```

Environment variables consulted (in priority order):

| Variable | Resolves to |
|---|---|
| `KANBAN_API_URL` | `apiUrl` |
| `KANBAN_CLI_OUTPUT` | `output` |
| `KANBAN_CLI_PROFILE` | `profile` |
| `KANBAN_CLI_TIMEOUT` | `timeout` |

The config file lives at `~/.config/kanban-cli/config.json` or
`${XDG_CONFIG_HOME}/kanban-cli/config.json`.
