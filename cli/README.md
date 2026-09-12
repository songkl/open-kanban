# Open Kanban CLI

Command-line client for the Open Kanban board. Authenticates with the Kanban
server using OAuth 2.1 (RFC 7591 + RFC 8628), then drives boards, columns,
and tasks from your terminal.

> **GitHub:** https://github.com/songkl/open-kanban

## Quick Start

```bash
# 1. Install (or use npx / a global install)
npm install
npm run build

# 2. Point at your Kanban server (defaults to http://localhost:8080)
export KANBAN_API_URL="https://kanban.example.com"

# 3. Log in via the OAuth 2.1 device flow
kanban auth login
#   → follow the printed URL, paste the user code, approve in your browser

# 4. Inspect the workspace
kanban status
kanban boards list
kanban columns list
kanban tasks list

# 5. Drive a task through the board
kanban tasks get <id>
kanban tasks create --title "Ship docs" --status todo
kanban tasks move <id> --status in_progress
kanban tasks complete <id>
```

The CLI stores the issued tokens at
`$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode 0600). The access
token is refreshed automatically before each request, so subsequent
invocations don't need to log in again.

To wipe the local credential store:

```bash
kanban auth logout
```

## Installation

```bash
npm install
npm run build
```

Or install globally so the `kanban` binary is on your `PATH`:

```bash
npm install -g .
kanban --help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KANBAN_API_URL` | `http://localhost:8080` | Kanban API server URL. |
| `KANBAN_CLI_PROFILE` | _(unset)_ | Profile name. Lets you keep multiple accounts side-by-side (e.g. `work` vs `personal`) without overwriting each other. |
| `--api-url <url>` | `KANBAN_API_URL` | Override the API URL for a single invocation. |
| `--profile <name>` | `KANBAN_CLI_PROFILE` | Override the profile for a single invocation. |
| `--output <format>` | `table` | Render tables or JSON (`table|json`). |

## OAuth 2.1 (default flow)

On `kanban auth login`, the CLI:

1. Discovers the authorization server via `GET /.well-known/oauth-authorization-server`
2. Dynamically registers itself via `POST /oauth/register` (RFC 7591, public client)
3. Requests a device code via `POST /oauth/device/code`
4. Prints the verification URL + user code to **stderr**:

   ```
   Open Kanban authorization required
     Visit:  http://localhost:8080/oauth/device
     Code:   HSXL-KQPR
     Scope:  kanban:read tasks:write
     Waiting for approval (expires in 600s)...
   ```

5. Polls `/oauth/token` until the user approves or the code expires
6. Encrypts and persists the token at `$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode 0600)
7. Auto-refreshes access tokens via the refresh_token grant before they expire

## Commands

### Auth

| Command | Description |
|---------|-------------|
| `kanban auth login` | Start OAuth 2.1 device flow and persist credentials. |
| `kanban auth status` | Show the current profile, host, scope, and access-token lifetime. |
| `kanban auth logout` | Delete the stored credentials. |
| `kanban auth whoami` | Call `GET /api/v1/users/me` and print the current user. |

### Read

| Command | Description |
|---------|-------------|
| `kanban status` | Probe the Kanban API; report latency, boards count, and API URL. |
| `kanban dashboard` | Fetch `GET /api/v1/dashboard/stats` and print a summary. |
| `kanban boards list [--fields a,b,c]` | List non-deleted boards (`GET /api/v1/boards`). |
| `kanban boards get <id>` | Fetch a single board (`GET /api/v1/boards/:id`). |
| `kanban columns list [--board <id>] [--positions 1,3]` | List columns (with embedded tasks). |
| `kanban columns get <id>` | Fetch a single column. |
| `kanban tasks list [--board] [--column] [--status] [--priority] [--assignee] [--search] [--since today\|thisWeek\|thisMonth] [--tag] [--lightweight] [--fields id\|id+updated]` | List tasks; filters apply client-side over the columns response. |
| `kanban tasks get <id>` | Fetch a single task (`GET /api/v1/tasks/:id`). |

### Write (auth required)

| Command | Description |
|---------|-------------|
| `kanban tasks create --title <t> [--description] [--column\|--status] [--board] [--priority] [--assignee] [--meta k=v] [--no-publish]` | Create a task (`POST /api/v1/tasks`). |
| `kanban tasks update <id> [--title] [--description] [--priority] [--assignee] [--meta] [--column\|--status]` | Update a task (`PUT /api/v1/tasks/:id`). |
| `kanban tasks delete <id> [--yes]` | Delete a task (`DELETE /api/v1/tasks/:id`). |
| `kanban tasks complete <id>` | Advance a task to the next column (`POST /api/v1/tasks/:id/complete`). |
| `kanban tasks move <id> [--column <id>\|--status <s>]` | Move a task to a target column or status. |
| `kanban tasks batch create [--file <json\|yaml>] [--title ...] [--column ...] [--description ...] [--priority ...] [--assignee ...] [--status ...]` | Create multiple tasks (`POST /api/v1/tasks/batch`). Either supply `--file` or repeat the field flags to build a positional list. |
| `kanban tasks batch update <ids...> [--file <ids.txt>] [--column\|--status] [--priority] [--assignee]` | Update multiple tasks at once (`PUT /api/v1/tasks/batch`). Ids may come from the positional list or a newline-delimited text file. |
| `kanban tasks batch delete <ids...> [--file <ids.txt>] [--yes]` | Delete multiple tasks (`DELETE /api/v1/tasks/batch`). `--yes` is the default and may be omitted. |
| `kanban subtasks list <taskId>` | List subtasks for a task (`GET /api/v1/subtasks?taskId=...`). |
| `kanban subtasks create <taskId> --title <t>` | Create a subtask (`POST /api/v1/subtasks`). |
| `kanban subtasks update <id> [--title <t>] [--completed\|--no-completed]` | Update a subtask (`PUT /api/v1/subtasks/:id`). At least one of `--title` / `--completed` must be supplied. |
| `kanban subtasks delete <id> [--yes]` | Delete a subtask (`DELETE /api/v1/subtasks/:id`). `--yes` is the default and may be omitted. |

### Batch input examples

```bash
# Create from a YAML file (a single object or a list of objects is fine).
kanban tasks batch create --file ./tasks.yaml

# Create from a JSON file.
kanban tasks batch create --file ./tasks.json

# Create from repeated flags; positions align across --title / --column /
# --priority / etc.
kanban tasks batch create \
  --title "Write spec"   --column col-todo   --priority high \
  --title "Implement X"  --column col-doing  --priority medium

# Update several tasks at once with the same patch.
kanban tasks batch update t1 t2 t3 --status done
kanban tasks batch update --file ./ids.txt --priority low --assignee alice

# Delete a list of ids (positions + file are concatenated, duplicates removed).
kanban tasks batch delete t1 t2 t3
kanban tasks batch delete --file ./ids.txt
```

The batch `--file` format accepts JSON or YAML. Each entry must include a
non-empty `title`; `columnId`, `priority`, `status`, `description`,
`assignee`, `published`, and `meta` are optional. An unknown status or
priority in the file raises an `InvalidUsageError` (exit code 1) before
any HTTP traffic, so typos fail fast.

## Exit codes

The CLI uses stable POSIX-style exit codes so scripts can branch on the
outcome without parsing stderr:

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Invalid usage (missing / conflicting flags) or other unexpected error. |
| `2` | Not logged in (run `kanban auth login` first). |
| `3` | User denied / device code expired during login. |
| `4` | Server error (HTTP 5xx). |
| `5` | HTTP not_found (e.g. board / task / column id missing). |
| `6` | Network error (e.g. server unreachable). |

## Development

```bash
npm install            # install dependencies
npm run lint           # tsc --noEmit (type-check the whole tree)
npm test               # vitest run (unit + e2e suites)
npm run build          # tsc + shebang → ./dist/index.js
npm run dev            # tsc --watch (recompile on save)
```

Tests live next to the code they cover (`src/**/*.test.ts`) and a
top-level integration suite lives under `tests/` that mocks `fetch` and
walks a full `auth login → boards list → tasks list → tasks complete`
flow against a fake server.

## License

MIT