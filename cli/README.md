# Open Kanban CLI

`kanban` is the command-line client for the [Open Kanban](https://github.com/songkl/open-kanban)
board. It speaks OAuth 2.1 (RFC 7591 + RFC 8628), drives every read /
write surface exposed by the HTTP API, and renders results as colour-aware
tables or JSON for piping into other tools.

> **GitHub:** https://github.com/songkl/open-kanban
> **中文文档:** [README_ZH.md](./README_ZH.md)

## What is `kanban`?

Open Kanban ships with three surfaces for driving the board:

| Surface | Audience | Protocol | Best for |
|---|---|---|---|
| **Web UI** (React) | Humans | Browser | Drag-and-drop editing, dashboards |
| **MCP server** (`open-kanban-mcp`) | AI agents | Model Context Protocol | Letting Claude Code / Cursor / OpenCode act on the board autonomously |
| **CLI** (`kanban`, this package) | Humans + scripts | OAuth 2.1 over HTTP | Shell pipelines, CI, cron, scripting from any language |

### CLI vs MCP — when to reach for which

- Use the **CLI** when you want a human-readable command, a shell pipe, a
  `cron` job, or a portable script that survives outside an MCP-aware host.
  The CLI speaks plain HTTPS and stores OAuth credentials in the same
  `$XDG_CONFIG_HOME` location the MCP server uses, so both can target the
  same workspace.
- Use the **MCP server** when an LLM host (Claude Code, Cursor, OpenCode…)
  needs to act on the board. The server exposes the same endpoints as the
  CLI but as MCP tools so the model can decide what to call.

Both share the same auth flow, so you can `kanban auth login` in a terminal
and the same credentials will be picked up by a local MCP server.

## Installation

The CLI is a Node.js (>= 18) binary. Pick whichever install flavour fits
your workflow:

### `npm` (local install)

```bash
cd cli
npm install
npm run build
# binary lives at ./dist/index.js
node ./dist/index.js --help
```

### `npx` (no install)

```bash
# Once the package is published to npm:
npx -y open-kanban-cli --help
```

### Global `npm`

```bash
npm install -g open-kanban-cli
kanban --help
```

### Homebrew (planned)

> Homebrew tap is not yet published. Track
> [issue #TBD](https://github.com/songkl/open-kanban/issues) for the tap
> formula. Once it lands:
>
> ```bash
> brew install songkl/tap/kanban
> kanban --help
> ```

After installing, confirm Node ≥ 18 is on `PATH`:

```bash
node --version   # must print v18.x or newer
```

## Quick Start

A complete first run — log in, inspect the workspace, create a task, and
move it across the board:

```bash
# 1. Point at your Kanban server (defaults to http://localhost:8080)
export KANBAN_API_URL="https://kanban.example.com"

# 2. Log in via the OAuth 2.1 device flow
kanban auth login
#   → follow the printed URL, paste the user code, approve in your browser

# 3. Inspect the workspace
kanban status          # probe the API; prints latency + boards count
kanban boards list     # see all boards (public endpoint, no auth needed)
kanban columns list    # see columns and their statuses

# 4. Create a task on the default board
kanban tasks create --title "Ship docs" --priority high

# 5. Drive it through the board
kanban tasks move <id> --status in_progress
kanban tasks complete <id>      # advances to the next column
```

The CLI stores the issued tokens at
`$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode `0600`). The
access token is refreshed automatically before each request, so subsequent
invocations don't need to log in again.

To wipe the local credential store:

```bash
kanban auth logout
```

## Commands at a glance

The full flag-level reference (every option, every example) lives in
[**docs/CLI_COMMANDS.md**](../docs/CLI_COMMANDS.md). Here is the high-level
shape of the command tree:

| Group | Purpose | Auth? |
|---|---|---|
| [`auth`](../docs/CLI_COMMANDS.md#auth--authentication) | OAuth 2.1 login / status / logout / whoami | mixed |
| [`status`](../docs/CLI_COMMANDS.md#status--api-probe) | Probe the API and print reachability | public |
| [`dashboard`](../docs/CLI_COMMANDS.md#dashboard--workspace-stats) | Workspace totals + per-status / per-priority breakdowns | required |
| [`boards`](../docs/CLI_COMMANDS.md#boards--board-navigation) | List / fetch boards | public |
| [`columns`](../docs/CLI_COMMANDS.md#columns--column-navigation) | List / fetch columns (with embedded tasks) | public |
| [`tasks`](../docs/CLI_COMMANDS.md#tasks--task-crud) | Create / read / update / delete / move / complete | mixed |
| [`tasks batch`](../docs/CLI_COMMANDS.md#tasks-batch--bulk-operations) | Bulk create / update / delete from a file or repeated flags | required |
| [`drafts`](../docs/CLI_COMMANDS.md#drafts--draft-tasks) | Manage unpublished draft tasks | required |
| [`archived`](../docs/CLI_COMMANDS.md#archived--archived-tasks) | List / archive / restore | required |
| [`comments`](../docs/CLI_COMMANDS.md#comments--task-comments) | Add (incl. stdin) / list | required |
| [`subtasks`](../docs/CLI_COMMANDS.md#subtasks--task-subtasks) | Create / update / complete / delete | required |
| [`mine`](../docs/CLI_COMMANDS.md#mine--current-agent-tasks) | Tasks assigned to the current agent | required |
| [`workspace`](../docs/CLI_COMMANDS.md#workspace--workspace-files) | Upload / read / list / delete workspace files | required |
| [`shell`](../docs/CLI_COMMANDS.md#shell--interactive-repl) | Interactive REPL | — |
| [`completion`](../docs/CLI_COMMANDS.md#completion--shell-completion) | Emit bash / zsh / fish completion scripts | — |
| [`config`](../docs/CLI_COMMANDS.md#config--view--update-settings) | View / update persistent CLI configuration | — |

For per-flag details and runnable examples, jump to
[**docs/CLI_COMMANDS.md**](../docs/CLI_COMMANDS.md).

### A few common flows

```bash
# Find what you should be working on right now
kanban mine

# Update a task and post a status comment
kanban tasks update t-42 --priority high
echo "Bumped to high — blocking the release." \
  | kanban comments add t-42 --body -

# Bulk-move every todo assigned to alice to in_progress
kanban tasks batch update --assignee alice \
  --status in_progress --column col-doing

# Upload a markdown spec to the workspace
kanban workspace upload ./spec.md --path specs/spec.md
```

## Configuration

The CLI resolves every setting through a four-level priority chain:

**CLI flag > environment variable > config file > built-in default**

### Global flags

| Flag | Default | Description |
|---|---|---|
| `--api-url <url>` | `http://localhost:8080` | Kanban API base URL. |
| `--profile <name>` | _(unset)_ | Profile name. Keep multiple accounts side-by-side (e.g. `work` vs `personal`) without overwriting each other. |
| `--output <format>` | `table` | Render output as `table` or `json`. (`yaml` is accepted by the flag but currently renders as `table`.) |
| `--no-color` | color on | Disable ANSI color in table output. Equivalent to `--color=off`. |
| `--color <mode>` | `auto` | Force color: `on` / `off` / `auto`. Honours `NO_COLOR` and `FORCE_COLOR`. |

### Environment variables

| Variable | Resolves to |
|---|---|
| `KANBAN_API_URL` | `apiUrl` |
| `KANBAN_CLI_PROFILE` | `profile` |
| `KANBAN_CLI_OUTPUT` | `output` |
| `KANBAN_CLI_TIMEOUT` | `timeout` (HTTP timeout in ms; config-only otherwise) |
| `NO_COLOR` / `FORCE_COLOR` | ANSI color override |

### Config file

Persistent settings live at
`~/.config/kanban-cli/config.json` (or
`${XDG_CONFIG_HOME}/kanban-cli/config.json`). The file is written with mode
`0600`.

```bash
# Inspect the resolved values
kanban config get

# Set a value
kanban config set apiUrl https://kanban.example.com
kanban config set output json
kanban config set timeout 60000
kanban config set profile work

# Clear the active profile
kanban config set profile ""
```

Supported keys: `apiUrl`, `output`, `profile`, `timeout`. See
[`config get / set`](../docs/CLI_COMMANDS.md#config--view--update-settings)
for validation rules.

## Exit codes

The CLI uses stable POSIX-style exit codes so scripts can branch on the
outcome without parsing stderr:

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Invalid usage (missing / conflicting flags) or other unexpected error. |
| `2` | Not logged in (run `kanban auth login` first). |
| `3` | User denied / device code expired during login, **or** HTTP 404 (`NotFoundError`). |
| `4` | Server error (HTTP 5xx). |
| `5` | HTTP not_found (e.g. board / task / column id missing). |
| `6` | Network error (server unreachable, DNS failure, TLS error, …). |

> Note: the legacy README documents `5` for "not_found" and `3` for denial
> / expiry. Both mappings are still in place — `3` covers denial and the
> `NotFoundError` thrown by `boards get` / `columns get` when the id is
> missing, while `5` covers generic 404s surfaced by the HTTP layer.

## Troubleshooting

### `kanban: command not found`

- You didn't install globally. Run `npm install -g open-kanban-cli` or use
  `npx open-kanban-cli`.
- Your global `node_modules/.bin` is not on `PATH`. Add it
  (`echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc`)
  and reload.

### `Not logged in. Run 'kanban auth login' first.`

The credentials cache is missing or expired.

```bash
# Inspect what the CLI sees
kanban auth status

# If the cache is empty or wrong, re-run the flow
kanban auth logout
kanban auth login
```

If `auth login` keeps printing `DeniedAuthorizationError`, double-check the
verification URL + user code printed to stderr and make sure your browser
session is logged into the Kanban server as the expected user.

### `Network error` / `ECONNREFUSED`

The CLI cannot reach `KANBAN_API_URL`. Verify the URL with `kanban status`
— it will mark the API `offline` and report latency. Common causes:

- Wrong `--api-url` (try `kanban config get apiUrl` to confirm).
- Server is on `localhost` but you are inside a container / WSL / remote
  shell — use the host's reachable address (e.g. `host.docker.internal`).
- TLS error — self-signed certs require adding the cert to the OS trust
  store; the CLI does not currently accept a `--insecure-skip-verify` flag.

### `401 Unauthorized` on every call

Tokens were issued against a different API URL than the one currently
configured. Each `--api-url` (or `KANBAN_API_URL`) gets its own credential
file at `credentials-<api>.json`. Switch back to the original URL or run
`kanban auth logout && kanban auth login` against the new endpoint.

### `exit code 3: DeniedAuthorizationError`

OAuth login was denied or the device code expired (default 600 s). Re-run
`kanban auth login` and approve faster.

### `exit code 1: invalid --fields value: ...`

`kanban tasks list --fields` only accepts `id` or `id+updated`. Anything
else fails fast (no HTTP traffic). Run without `--fields` for the default
projection.

### Confusing `mine` output

`kanban mine --board <id>` prints `warning: --board is not supported by
/api/v1/mcp/my-tasks; ignoring boardId=<id>` to stderr. The flag is a
forward-compatibility shim — the endpoint does not accept a board filter.
Drop the flag and filter client-side instead.

### `--output yaml` renders as a table

`yaml` is accepted by the `--output` flag for forward compatibility, but
the action handlers currently normalise anything other than `json` to
`table`. Use `--output json` and pipe through `yq` or `jq` for now.

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

## Shell completion

The CLI ships with completion scripts for bash, zsh, and fish. Static
suggestions (subcommands, flags, allowed enum values) are baked into the
script so completion is instant even when the API is unreachable;
dynamic values (boardId, columnId, taskId, …) are fetched lazily through
`kanban __complete <line>` whenever you press <kbd>Tab</kbd>.

```bash
# bash — system-wide (requires bash-completion):
kanban completion bash | sudo tee /etc/bash_completion.d/kanban

# bash — per-user:
kanban completion bash > ~/.kanban-completion.bash
echo 'source ~/.kanban-completion.bash' >> ~/.bashrc

# zsh — drop the file somewhere on $fpath:
kanban completion zsh > "${fpath[1]}/_kanban"
autoload -Uz compinit && compinit

# fish — current session / persistent:
kanban completion fish | source
kanban completion fish > ~/.config/fish/completions/kanban.fish
```

A manpage (`cli/man/kanban.1`) is also shipped for `man kanban`.

## License

MIT
