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
#   → if the server detects a CLI / MCP client it will show an
#     "Authorise as" selector — pick **Myself** to bind the token to
#     your own account, or pick an enabled Agent (the default if
#     `oauth_device_agent_id` is pinned globally). See
#     [Device-flow Agent selection](../docs/CLI_COMMANDS.md#device-flow-agent-selection).

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

> **Heads-up for `kanban run` operators:** every `kanban run`
> deployment *must* end up holding a bearer whose
> `users.type='AGENT'`. When approving the device flow, pick an Agent
> from the selector — picking "Myself" would leave you unable to claim
> tasks at `/api/v1/runs/claim`. The end-to-end walkthrough lives in
> [`docs/CLI_USER_GUIDE.md` §2.2](../docs/CLI_USER_GUIDE.md#22-device-flow-agent-选择--pick-which-identity-the-device-flow-binds-to).

The CLI stores the issued tokens at
`$XDG_CONFIG_HOME/kanban-cli/credentials-<api>.json` (mode `0600`). The
access token is refreshed automatically before each request, so subsequent
invocations don't need to log in again.

To wipe the local credential store:

```bash
kanban auth logout
```

## Commands at a glance

> New to the CLI? Start with [**docs/CLI_USER_GUIDE.md**](../docs/CLI_USER_GUIDE.md)
> — a tutorial-style walkthrough (mixed CN/EN) with runnable examples for
> every common workflow.

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
| [`run`](../docs/CLI_COMMANDS.md#run--runner-loop) | Runner loop (claim → spawn agent → heartbeat → finish) | mixed |
| [`runs`](../docs/CLI_COMMANDS.md#runs--terminal-task-run-history) | List past terminal task runs | required |
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

## Runner

`kanban run` is a long-lived process that watches a board/column
(mode-1) or the authenticated agent's task inbox (mode-2), spawns a
local agent binary for each claimed task, heartbeats the lock on a
fixed cadence, and reports the outcome back via
`POST /api/v1/runs/:taskId/finish`. The full design lives in
[`devDoc/CLI_RUNNER_PLAN_2026-09-12.md`](../devDoc/CLI_RUNNER_PLAN_2026-09-12.md);
the per-flag reference is in [`man kanban-run`](./man/kanban-run.1.md).

### Quick start

```bash
# 1. Log in once
kanban auth login

# 2. Scaffold the config interactively (recommended). The wizard
#    pulls the board list from the live API so you never have to
#    copy/paste an id, and validates every field before writing.
kanban run init

# 2b. Or: drop a project config next to your code by hand
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

# 3. Start the loop (foreground). Ctrl-C triggers a graceful drain.
kanban run

# 4. Or: process a single task and exit (cron-friendly).
kanban run --once

# 5. Or: watch the agent's task inbox instead of a fixed column.
kanban run --mine
```

### `kanban run init` (interactive wizard)

When invoked without arguments, `kanban run init` walks through every
field the runner needs:

1. **Mode** — board-bound (one board + column status) or identity-bound
   (`mode: mine`).
2. **Board + status** — fetched live from `GET /api/v1/boards` and
   `GET /api/v1/columns`, so the wizard never asks you to paste an id
   you don't already have.
3. **Agent block** — `bin` + optional absolute `binPath`, prompt
   delivery (`arg` / `stdin` / `file`), `cwd`, extra args, extra env
   vars, and a per-task timeout.
4. **Runner cadences** — poll / heartbeat / lock timeouts, max
   concurrency, and an optional static `runnerId`. The wizard enforces
   `lockTimeoutMs > 2 × heartbeatIntervalMs` before it lets you write.
5. **Scope** — `.kanban-runner.yaml` (project-shared, commit-safe) or
   `.kanban-runner.local.yaml` (machine-local override, gitignored).

The wizard refuses to overwrite an existing file unless you confirm,
and the resulting YAML is round-tripped through `parseConfig` so the
runner will load it without surprises.


### Modes

The runner has two mutually exclusive modes; the validator fails
fast (exit code 1) if both are present at once.

**Mode 1 — board-bound.** The runner claims from a fixed column on
a fixed board. Pair `--board <id>` with `--status <s>` (or set
`boardId` + `status` in the config). Every task in that column
whose `column_agents` grant includes your agent type is fair
game. This is the canonical "team pool" mode.

**Mode 2 — identity-bound (`--mine`).** The runner asks the
server for the next task in your profile's inbox (the same
endpoint `kanban mine` reads from). The runner's OAuth token
must have `kanban:read` + `tasks:write` and the resolved task
must live on a board you can access. There is no column
filter — the server picks. Drop `boardId` / `status` from the
config and set `mode: mine` (or pass `--mine` on the command
line) to use this mode.

A minimal mode-2 config:

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

### Flags

| Flag | Default | Description |
|---|---|---|
| `--config <file>` | _(discovery)_ | Read the runner config from this file instead of walking up from `cwd`. |
| `--board <id>` | _(unset)_ | Mode-1 board id. Must pair with `--status`. |
| `--status <s>` | _(unset)_ | Mode-1 column status (`todo` / `in_progress` / `review` / `done`). |
| `--mine` | `false` | Mode-2: pick tasks assigned to (or routed to) the authenticated agent. Requires `kanban auth login`. |
| `--once` | `false` | Process a single task and exit. Useful for cron jobs / smoke tests. |

### Configuration discovery

The runner walks up from the current working directory until it finds
one of:

1. `./.kanban-runner.local.yaml` — machine-local override (gitignored)
2. `./.kanban-runner.yaml` — project-shared config (checked in)
3. `~/.config/kanban-cli/runner.json` — global fallback

When a local override and a project file sit in the same directory
they are deep-merged (local wins on conflict; arrays like `args` are
replaced wholesale). The full schema and validation rules are
documented in [`cli/man/kanban-run.1.md`](./man/kanban-run.1.md) and
`devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §2.2 / §4.6.

### Signals

The loop installs `SIGINT` and `SIGTERM` handlers that call
`requestShutdown()`. The current in-flight agent (if any) is sent
`SIGTERM`, the loop waits up to 15 s for it to drain, then
`POST /api/v1/runs/release` is called to release any orphan locks
before the process exits.

### Troubleshooting

**`no runner config found: walked up from '<cwd>' looking for ...`**

The discovery walk didn't find `.kanban-runner.local.yaml`,
`.kanban-runner.yaml`, or `~/.config/kanban-cli/runner.json`.
Either drop a config in the working directory, point at one
explicitly with `--config <path>`, or create the global
fallback file under `~/.config/kanban-cli/`.

**`config is incomplete: provide either 'boardId' + 'status' or 'mode: mine'`**

You picked neither mode-1 nor mode-2. Add both `boardId` and
`status` to the config (or pass `--board X --status todo`), or
add `mode: mine` (or pass `--mine`). The two modes are
mutually exclusive; combining them is rejected with a different
error.

**`config is ambiguous: 'mode: mine' is mutually exclusive with 'boardId' / 'status'`**

Drop the `boardId` / `status` keys when `mode: mine` is set,
or vice versa.

**`agent.bin '<x>' is neither an absolute path nor resolvable via PATH`**

`agent.bin` must be on `$PATH` (e.g. `opencode`) or be an
absolute path to an executable. The runner does not search
`./node_modules/.bin` for you — use `npx <tool>` or an
absolute path. If the binary lives in a non-standard location,
`agent.binPath` overrides the resolution path entirely.

**`runner.lockTimeoutMs (...) must be greater than 2 × runner.heartbeatIntervalMs (...)`**

The server uses `lockTimeoutMs` as the deadline after which a
stalled run is reaped. To avoid the loop racing the reaper,
`lockTimeoutMs` must be at least twice `heartbeatIntervalMs`,
otherwise a single missed heartbeat would let the server reap
the lock while the runner is still alive.

**`mode 'mine' requires CLI profile '<x>' to be logged in; run 'kanban auth login' first`**

Mode-2 needs OAuth credentials on disk. Run `kanban auth login`
(or pass `--api-url` + `--profile <name>` to log in to a
non-default profile) before starting the loop.

**`claim failed: ... (retryable=false)` / loop exits with code 1**

Non-retryable claim errors are surfaced immediately and shut
the loop down. Common causes:

* `401 Unauthorized` — the OAuth token is stale or wrong
  profile; `kanban auth logout && kanban auth login`.
* `403 Forbidden: No permission to claim tasks in this column` —
  the runner's user / token doesn't have WRITE on the column
  (or its board fallback). Add a `board_permissions` grant or
  use a token whose user has the right role.
* The token's `user_agent` no longer has to match the body's
  `agentType` since s-1161 — the CLI's default of `opencode` is
  used as a routing hint, but the server falls back to the
  token's `user_agent` when the body omits the field, and
  honours the body verbatim when both are present. To target a
  specific agent class, set `agentType` on the body or
  `KANBAN_RUNNER_AGENT_TYPE` in the environment.

**`task ... finish returned 409 (lost)`**

Another runner (or the reaper) took the lock between claim and
finish. The loop logs `warn` and increments the `failed`
counter; the task is left in its current column (typically
`in_progress`). Re-claim it manually if you want to retry.

**The agent exits cleanly (0) but the task stays in `in_progress`**

`finish()` only moves the task when `status='completed'`.
The runner sends `'completed'` only when the agent exited
with code 0 AND the exit reason was `'exit'` (not a signal /
timeout / spawn error). If the agent was killed by SIGTERM
because it ran past `agent.timeoutMs`, you'll see the task
revert on the next loop iteration via the server's reaper.

## License

MIT
