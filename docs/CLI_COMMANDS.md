# Kanban CLI — Command Reference

This document is the detailed flag-level reference for every command exposed
by the `kanban` binary. For a beginner-friendly tutorial-style walkthrough
(mixed CN/EN) with runnable examples, see
[`docs/CLI_USER_GUIDE.md`](./CLI_USER_GUIDE.md). For an end-to-end onboarding
flow, configuration overview, troubleshooting, and exit-code table, see
[`cli/README.md`](../cli/README.md).

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
  - [`auth agent` — bind the CLI to an Agent identity](#auth-agent--bind-the-cli-to-an-agent-identity)
  - [Device-flow Agent selection](#device-flow-agent-selection)
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
- [`run` — runner loop](#run--runner-loop)
  - [`run start` (default action)](#run-start-default-action)
  - [`run init` — interactive wizard](#run-init--interactive-wizard)
- [`runs` — terminal task-run history](#runs--terminal-task-run-history)
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

#### Device-flow Agent selection

When the device-flow approval page is opened for a CLI / MCP client
(heuristic: the OAuth client's name matches `kanban-cli` /
`open-kanban-cli` / `*-cli`, or its `grant_types` includes
`urn:ietf:params:oauth:grant-type:device_code`), the human approver is
asked to **pick which identity the device code will be bound to**:

- **Myself (your account)** — bind the access token to the human
  approver's own row (`type='HUMAN'`). Useful when the user is testing
  the CLI interactively and wants to scope writes to their own account.
- **An enabled Agent** — bind the access token to a row whose
  `users.type='AGENT'`. Every `kanban run` deployment *must* end up
  here; see [§ Hard requirement](#hard-requirement) below. The page
  lists each candidate with its nickname, avatar, and role. ADMIN-role
  Agents are only visible to ADMIN approvers.

If the server admin has pinned a global fallback via the
`oauth_device_agent_id` setting, that Agent is pre-selected and the
page shows a **"(Server default agent)"** badge — change it if needed
before clicking Approve.

The selection is POSTed to `/oauth/device/approve` as `agent_id` (or
omitted, to mean "Myself"). The handler then binds
`oauth_device_codes.user_id`, `oauth_consents.user_id`, and the audit
log to the chosen row. The JWT the CLI eventually receives therefore
has `sub=<chosen id>` and the runner's
`backend/internal/handlers/tasks_run.go:133-141` claim check
(`tokens.user_agent`) keeps working without further changes.

##### Hard requirement

> **The `kanban run` CLI runner is exclusively for Agent use.**

When the server has the `oauth_device_require_agent_selection=1` flag
set (see `OAuthSettings` in the Web UI), approving the device flow as
the human approver (i.e. picking **"Myself"** with a HUMAN row) is
rejected with `400 invalid_request` unless the approver is themselves
already an Agent (`type='AGENT'`). This is the boundary enforcement
that backs the "CLI runner is for Agent use" guarantee — without it,
`kanban run` would either refuse every claim or, worse, allow a
human to impersonate an Agent. The flag is opt-in (default `0`); flip
it on once every consumer has been migrated to the new selector.

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

### `auth agent` — bind the CLI to an Agent identity

```
kanban auth agent list
kanban auth agent create <nickname> [--avatar <url>] [--role <role>] [--no-bind]
kanban auth agent bind [--token <token>]
kanban auth agent delete <agentId>
```

The `auth login` device flow always binds the resulting access token to
the human approver. For unattended / automation use cases (the runner,
CI pipelines, watchdogs) this leaks the admin identity into every
audit trail and prevents the `kanban mine` inbox from filtering by
agent-type. The `auth agent` sub-commands close that gap by minting
(or accepting) an Agent API token and writing it to the CLI's encrypted
credential store in place of the human session.

Once the credential store holds an Agent token, every subsequent
`kanban ...` call runs as that Agent and `auth status` reports
`Identity: Agent (long-lived token)`. Use `auth logout` to wipe the
profile and fall back to a human session.

> **Note:** `auth agent create` and `auth agent delete` require an
> existing admin OAuth session (`kanban auth login`). `auth agent bind`
> does not — the supplied token is the credential.

#### `auth agent list`

```
kanban auth agent list
```

`GET /api/v1/auth/agents` — print the configured Agents (id, nickname,
role, enabled, last active). Admin OAuth session required.

#### `auth agent create <nickname>`

```
kanban auth agent create ci-runner --role ADMIN
```

`POST /api/v1/auth/agents` — mint a new Agent and bind the freshly
returned API token to the local profile. The CLI prints the token
once; copy it to a secret manager immediately.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--avatar <url>` | string | _(empty)_ | Avatar URL stored on the Agent row. |
| `--role <role>` | string | `ADMIN` | `ADMIN` / `MEMBER` / `VIEWER`. |
| `--no-bind` | boolean | `false` | Dry-run: do not persist the new token. |

Admin OAuth session required (returns 403 otherwise).

#### `auth agent bind`

```
kanban auth agent bind --token agt_xxx...
# or
KANBAN_AGENT_TOKEN=agt_xxx... kanban auth agent bind
# or interactively (password-masked prompt)
kanban auth agent bind
```

Take an externally-issued Agent API token (from the Settings → Agents
page, or pasted from `auth agent create`'s output) and persist it to
the credential store. The CLI validates the token against
`GET /api/v1/users/me` and refuses to bind when the resolved user is
not of `type='AGENT'` — this prevents accidentally downgrading an
admin session to a HUMAN token.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--token <token>` | string | _(prompt / `KANBAN_AGENT_TOKEN`)_ | Agent API token to persist. If omitted the CLI falls back to the `KANBAN_AGENT_TOKEN` env var, then prompts (input is masked). |

#### `auth agent delete <agentId>`

```
kanban auth agent delete agent-1
```

`DELETE /api/v1/auth/agents?id=<agentId>`. Admin OAuth session required.

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

## `run` — runner loop

Group description: _drive the long-lived runner loop (claim → spawn agent →
heartbeat → finish)_ / 运行 runner 循环,负责抢任务、拉起 agent、发心跳、回报结果.
**Auth is required for mode-2 (`--mine`); mode-1 uses the resolved CLI profile
for OAuth credentials and otherwise only needs board / column ids that the
server already knows.**

The runner is a self-contained state machine — see
[`devDoc/CLI_RUNNER_PLAN_2026-09-12.md`](../devDoc/CLI_RUNNER_PLAN_2026-09-12.md)
for the design. The reference below only covers the CLI surface (flags,
discovery, validation, exit codes).

### Modes / 两种模式

The runner has two mutually exclusive modes. The CLI fails fast (exit code
`1`) when both are present at once, and when neither is present it walks up
from `cwd` looking for a config file (see [Configuration discovery](#configuration-discovery)).

| Mode | How to enable | Use case / 适用场景 |
|---|---|---|
| **Mode 1 — board-bound** | `--board <id> --status <s>` (or `boardId` + `status` in the config) | Team pool: watch a single column on a single board / 监听固定看板的固定列. |
| **Mode 2 — identity-bound (`--mine`)** | `--mine` (or `mode: mine` in the config) | Agent inbox: pick any task assigned to (or routed to) the authenticated agent, regardless of board / 监听当前 profile 名下的任务. |

### `run start` (default action)

```
kanban run [--config <file>] [--board <id> --status <s> | --mine] [--once]
kanban run start [...]  # explicit alias for the same handler
```

Start the runner loop. `kanban run <flags>` (no subcommand) routes to the same
handler as `kanban run start` — the two spellings are interchangeable.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--config <file>` | string | _discovery_ | Explicit path to a `.kanban-runner{.local}.yaml` / `.json`. Overrides the walk-up. |
| `--board <id>` | string | _(unset)_ | Mode-1 board id. Must pair with `--status` on the same command line. |
| `--status <s>` | string | _(unset)_ | Mode-1 column status. Allowed: `todo` / `in_progress` / `review` / `done`. |
| `--mine` | boolean | `false` | Mode-2: pick from the authenticated agent's inbox. Requires `kanban auth login`. Mutually exclusive with `--board` / `--status`. |
| `--once` | boolean | `false` | Process a single task and exit. The loop still installs `SIGINT` / `SIGTERM` handlers, but it does not poll for new claims once the first task has been drained (or if no claim is available within the configured poll interval). Handy for cron jobs and smoke tests. |

On startup the loop:

1. Calls `POST /api/v1/runs/claim` to atomically acquire the next eligible
   task whose column advertises the runner's agent type.
2. Spawns the configured agent binary, passing it a rendered markdown prompt
   that includes the board / column / task context.
3. Calls `POST /api/v1/runs/:taskId/heartbeat` every `heartbeatIntervalMs`
   milliseconds while the agent runs.
4. On exit, calls `POST /api/v1/runs/:taskId/finish` with `status="completed"`
   (exit code 0 + reason `exit`) or `status="failed"` (non-zero / timeout /
   signal). Failures also leave a comment via `POST /api/v1/comments`.

`Ctrl-C` is graceful: the in-flight agent is sent `SIGTERM` and the runner
releases its locks via `POST /api/v1/runs/release` before exiting.

```bash
# Watch the sys board's todo column, run forever
$ kanban run --board sys --status todo

# Process one task from the agent inbox and exit (cron-friendly)
$ kanban run --mine --once

# Pin a specific config file (CI)
$ kanban run --config /etc/kanban-runner.yaml --once
```

#### Exit codes / 退出码

| Code | Meaning / 含义 |
|---|---|
| `0` | Loop terminated gracefully with no in-flight task, or `--once` completed normally. |
| `1` | Invalid usage (missing / conflicting flags, malformed config, validation failure). |
| `2` | Not logged in — triggered when `--mine` / `mode: mine` is configured but the active profile has no stored credentials. |
| `3` | HTTP 404 from a server endpoint. |
| `4` | Server error (HTTP 5xx); the loop logs the failure and either retries (transient) or exits (after exhausting retries). |
| `6` | Network error (DNS failure, TLS error, server unreachable). |

### Configuration discovery / 配置文件查找

When `--config` is not supplied, the runner walks up from the current working
directory until it finds one of:

1. `./.kanban-runner.local.yaml` — machine-local override (gitignored).
2. `./.kanban-runner.yaml` — project-shared config (checked into git).
3. `~/.config/kanban-cli/runner.json` — global fallback.

When both a local override and a project file sit at the same directory they
are deep-merged (local wins on conflict; array fields like `args` are
replaced wholesale). The full schema and validation rules are documented in
[`cli/man/kanban-run.1.md`](../cli/man/kanban-run.1.md) and
`devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §2.2 / §4.6.

Minimal Mode-1 config:

```yaml
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
```

Minimal Mode-2 config:

```yaml
version: 1
mode: mine
agent:
  bin: opencode
  cwd: .
  args: ["--non-interactive"]
  timeoutMs: 1800000
runner:
  pollIntervalMs: 5000
  heartbeatIntervalMs: 30000
  lockTimeoutMs: 120000
```

Validation rules (loop refuses to start when any fails):

- `agent.bin` is not an absolute path on disk and is not resolvable via
  `PATH`.
- `runner.lockTimeoutMs` is not strictly greater than 2 ×
  `runner.heartbeatIntervalMs` (otherwise an in-flight task could be reaped
  before its next heartbeat).
- `mode: mine` is selected but the active CLI profile is not logged in.
- Both `boardId` + `status` are missing AND `mode` is not `mine`.

#### Startup health probe / 启动时的健康检查

Right after the loop is constructed, `defaultBuildLoop` issues a one-shot
`GET /api/v1/boards` (and, for mode-1, `GET /api/v1/columns?boardId=…`) to
make sure the config still points at a board / status that exist on the
server. If the configured `boardId` is missing — usually because the
server's seeded boards were reset, or the operator is pointing at a
stale config from a different environment — the loop logs a single
`[kanban-runner] warn:` line per problem and keeps running. This keeps
the user from having to drop into `--debug` archaeology just to figure
out why every claim returns `204 / no-content (idle)`.

```text
$ kanban run --board sys --status todo
[kanban-runner] runner host-1234-abcd starting
[kanban-runner] debug: loop config: mode=board boardId=sys status=todo …
[kanban-runner] warn: configured boardId is missing on the server; available boards: default
[kanban-runner] warn: hint: re-run `kanban run init` (or pass --board on the CLI) to point at an existing board
[kanban-runner] debug: claim attempt: boardId=sys status=todo mode=board
[kanban-runner] debug: claim returned 204/no-content (idle)
…
```

The probe is fire-and-forget — HTTP failures (network down, 401, etc.)
are swallowed so the loop's own retry path keeps being the source of
truth for transport errors. mode=`mine` skips the probe entirely.

### `run init` — interactive wizard / 交互式配置向导

```
kanban run init
```

Scaffold a `.kanban-runner.yaml` (or `.kanban-runner.local.yaml`)
interactively. The wizard walks through every field the runner needs and
fetches boards + columns live from `GET /api/v1/boards` / `GET /api/v1/columns`
so you never have to copy/paste an id blind.

Steps:

1. **Mode** — board-bound (one board + column status) or identity-bound
   (`mode: mine`).
2. **Board + status** — fetched live from the API; the wizard refuses
   hand-typed ids.
3. **Agent block** — `bin` + optional absolute `binPath`, prompt delivery
   (`arg` / `stdin` / `file`), `cwd`, extra args, extra env vars, and a
   per-task `timeoutMs`.
4. **Runner cadences** — poll / heartbeat / lock timeouts, max concurrency,
   optional static `runnerId`. The wizard enforces
   `lockTimeoutMs > 2 × heartbeatIntervalMs` before it lets you write.
5. **Scope** — `.kanban-runner.yaml` (project-shared, commit-safe) or
   `.kanban-runner.local.yaml` (machine-local override, gitignored).

The wizard refuses to overwrite an existing file unless you confirm, and the
resulting YAML is round-tripped through `parseConfig` so the runner will
load it without surprises.

```bash
$ kanban run init
#   ? Mode:  board-bound
#   ? Board: sys
#   ? Status: todo
#   ? Agent bin: opencode
#   ? Cwd: .
#   ? Extra args: --non-interactive
#   ? Timeout (ms): 1800000
#   ? Poll interval (ms): 5000
#   ? Heartbeat interval (ms): 30000
#   ? Lock timeout (ms): 120000
#   ? Scope: .kanban-runner.yaml
# ✓ wrote .kanban-runner.yaml
```

### Troubleshooting / 常见问题

| Symptom | Cause | Fix |
|---|---|---|
| `no runner config found: walked up from '<cwd>' looking for ...` | Discovery walk found nothing | Drop a config in the working directory, point at one explicitly with `--config <path>`, or create the global fallback under `~/.config/kanban-cli/`. |
| `config is incomplete: provide either 'boardId' + 'status' or 'mode: mine'` | Picked neither mode | Add both `boardId` + `status` (or pass `--board X --status todo`), or add `mode: mine` (or pass `--mine`). |
| `config is ambiguous: 'mode: mine' is mutually exclusive with 'boardId' / 'status'` | Set both | Drop the `boardId` / `status` keys when `mode: mine` is set, or vice versa. |
| `agent.bin '<x>' is neither an absolute path nor resolvable via PATH` | Bad `bin` | Use an absolute path or one on `$PATH`; the runner does not search `./node_modules/.bin` for you. `agent.binPath` overrides the resolution path entirely. |
| `runner.lockTimeoutMs (...) must be greater than 2 × runner.heartbeatIntervalMs (...)` | Lock timeout too short | Bump `lockTimeoutMs`. |
| `mode 'mine' requires CLI profile '<x>' to be logged in` | No OAuth session | `kanban auth login` (or pass `--api-url` + `--profile <name>` to log in to a non-default profile) before starting the loop. |
| `claim failed: ... (retryable=false)` / loop exits with code `1` | `401 Unauthorized` / `403 Forbidden` / token mismatch | Re-login, or fix the column's `column_agents` grant so the runner's `user_agent` is allowed. |
| `task ... finish returned 409 (lost)` | Another runner (or the reaper) took the lock between claim and finish | The loop logs `warn` and increments the `failed` counter; the task is left in its current column. Re-claim manually if you want to retry. |
| The agent exits cleanly (`0`) but the task stays in `in_progress` | `finish()` only moves the task when `status='completed'` | The runner sends `'completed'` only when the agent exited with code `0` AND the reason was `exit` (not a signal / timeout / spawn error). If the agent was killed by `SIGTERM` for running past `agent.timeoutMs`, the task reverts on the next loop iteration via the server's reaper. |

---

## `runs` — terminal task-run history

Group description: _inspect past task-run history_ / 查看 runner 跑过的历史任务.
**Auth required.**

The `runs` group only lists **terminal** rows (`status ∈ completed | failed | released`)
served by `GET /api/v1/runs/history`. Live locks held by a running `kanban run`
loop are intentionally *not* surfaced here — they live on the server's locks
table and the runner's own process. To debug a stuck claim, use `runs list
--status failed` or read the reaper logs.

### `runs list`

```
kanban runs list
  [--runner-id <id>]
  [--since <duration>]
  [--status <status>]
  [--task <id>]
  [--board <id>]
  [--limit <n>]
  [--offset <n>]
```

Fetch `GET /api/v1/runs/history` and render the result as a table
(`taskId / status / runnerId / finishedAt / duration / error`) or raw JSON.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--runner-id <id>` | string | _(all)_ | Filter by exact runner identifier (forwards to `?runnerId=`). |
| `--since <duration>` | string | _(all)_ | Lower bound on `finishedAt`. Accepts a relative duration `1d` / `2h` / `30m` / `1w` / `45s` (units: `s` / `m` / `h` / `d` / `w`, case-insensitive) **or** an absolute `YYYY-MM-DD` / RFC3339 timestamp forwarded verbatim. |
| `--status <status>` | string | _(all)_ | Filter by terminal status. Allowed: `completed` / `failed` / `released`. |
| `--task <id>` | string | _(all)_ | Filter by task id (forwards to `?taskId=`). |
| `--board <id>` | string | _(all)_ | Filter by board id (forwards to `?boardId=`). |
| `--limit <n>` | integer | server default `50` (capped at `200`) | Pagination size. Must be a positive integer; non-integer values raise `InvalidUsageError` (exit `1`) before any HTTP traffic. |
| `--offset <n>` | integer | `0` | Pagination offset. Must be a non-negative integer. |

Invalid `--status` values raise `InvalidRunStatusError` (exit `1`); invalid
`--since` values raise `InvalidSinceError` (exit `1`). Both fail fast without
sending an HTTP request.

```bash
# Last 24 hours of failures across all runners
$ kanban runs list --since 1d --status failed

# What did a specific runner do this week?
$ kanban runs list --runner-id host-42-pid-7-uuid --since 1w

# Page through the history for a single task
$ kanban runs list --task task-123 --limit 50 --offset 0
```

The table renders the elapsed `duration` between `claimedAt` and
`finishedAt` (humanised as `42ms` / `3s` / `1m20s` / `1h5m`). Empty results
print `(no runs)` so scripts can branch on the table without parsing stderr.

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

---

## Where to go next

- Tutorial-style walkthrough with runnable examples (mixed CN/EN):
  [`docs/CLI_USER_GUIDE.md`](./CLI_USER_GUIDE.md)
- End-to-end onboarding, troubleshooting, exit-code table:
  [`cli/README.md`](../cli/README.md)
- Runner design (`kanban run`):
  [`devDoc/CLI_RUNNER_PLAN_2026-09-12.md`](../devDoc/CLI_RUNNER_PLAN_2026-09-12.md)
- Manpage: [`cli/man/kanban.1`](../cli/man/kanban.1)
