# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- s-1131: tighten the CLI auth login UX and surface Agent creator
  identity end-to-end so unattended operators stop accidentally
  binding their human approver's session to the runner. The
  device-flow approval page now requires an explicit confirmation
  click before the approve request leaves the browser — the first
  click on "Approve" opens a confirmation banner summarising which
  identity (Human / Agent) the device code will be bound to, and
  the second click submits. The banner copy is Agent-aware
  ("Authorise as an Agent?") so the approver can't miss the
  difference between the two paths. CLI `kanban auth login` now
  prints the deep-link URL with the user_code pre-filled
  (`?code=XXXX-XXXX`) instead of the bare verification URI, and
  emits a yellow "Identity selection" hint whenever the OAuth
  client registration looks like a CLI / MCP consumer so
  unattended operators know they need to pick an Agent on the
  approval page. Backend ships migration 008 (sqlite + mysql) that
  adds `users.created_by TEXT REFERENCES users(id) ON DELETE SET
  NULL`; `POST /api/v1/auth/agents` stamps the creator at insert
  time, `GET /api/v1/auth/agents` surfaces `createdBy` plus the
  creator's nickname / username via a `LEFT JOIN`, and the new
  field round-trips through `kanban auth agent {list,create}` —
  the list table grows a "Created by" column that auto-hides on
  legacy payloads and renders "(legacy)" for individual rows the
  server doesn't have creator info for. Pre-existing AGENT rows
  created before this migration stay alive with `created_by =
  NULL` (the column is intentionally nullable so the migration is
  lossless; `ON DELETE SET NULL` keeps Agents alive when the
  creator is removed). 4 backend tests + 7 CLI tests + 3
  Vitest cases + 1 migration round-trip test cover the new
  flow.
- s-1130: add `kanban attach <taskId>` so an AI agent / operator can
  claim one specific task by id without owning the surrounding
  column or inbox (the "AI-first" entry point). Backed by the new
  `POST /api/v1/runs/:taskId/attach` endpoint, which enforces the
  same per-column WRITE permission as `/runs/finish`, rejects
  archived / unpublished tasks with `422`, and returns the same
  `{ task, run }` payload as `/runs/claim` so the CLI prompt-
  rendering path is unchanged. The runner loop (`kanban run`)
  additionally subscribes to the server's `/ws` broadcast stream
  and wakes immediately on a `task_notification` for the watched
  board, replacing the old 5s polling fallback with WS push while
  keeping the poll as a safety net for dropped connections. New
  `ClaimRun` / `AttachRun` broadcasts fan out `update_status` /
  `attach` actions through the existing broadcastQueue so the
  web UI's `useBoardWebSocket` hook picks up the state change
  without waiting for the next refresh tick. 14 backend tests
  (attach happy / 404 / 422 / 403 / 401 / 409 / reason / agent-
  type-fallback / agent-type-mismatch / ClaimRun broadcast /
  AttachRun broadcast) and 13 CLI tests cover the new endpoint,
  the new command, the loop wake-up path, and the WS subscription
  reconnect logic.
- s-1102: add `kanban auth agent {list,create,bind,delete}` so the CLI
  can bind to an Agent identity (long-lived API token) instead of the
  human approver's OAuth session. `auth status` now reports
  `Identity: Agent / Human` and `auth agent bind` validates the token
  via `GET /api/v1/users/me` to refuse HUMAN tokens.
- s-1073: add `kanban subtasks {list,create,update,delete}` so the CLI
  can manage task subtasks. `subtasks list <taskId>` GETs
  `/api/v1/subtasks?taskId=<id>`, `subtasks create <taskId> --title <t>`
  POSTs `{ taskId, title }`, `subtasks update <id> [--title <t>]
  [--completed|--no-completed]` PUTs the supplied fields, and
  `subtasks delete <id>` DELETEs the record with `--yes` as the
  default. 42 vitest cases mock HTTP and cover URL/body shape, JSON
  output, table rendering, ID encoding, and 401/404 error mapping.
- s-1077: add `kanban shell`, an interactive readline REPL that wraps the
  same Commander program used by the top-level CLI. Features include
  up/down arrow history persisted to `~/.kanban_shell_history`
  (overridable via `KANBAN_SHELL_HISTORY`), Tab completion for top-level
  commands, subcommands, and global flags, and built-ins `help`,
  `exit`/`quit`, `clear`, `whoami`. On entry the shell automatically
  runs `auth status` and prints a yellow "not logged in" hint when no
  credentials are stored while keeping the REPL open; a leading `kanban`
  token is stripped from each line so users can paste full commands;
  and `process.exit` is shimmed so commands that request an exit code do
  not terminate the shell. 13 unit tests cover `completeLine`,
  `defaultHistoryPath`, banner rendering, the auth-probe short-circuit,
  dispatch with shell-level flag injection, and the `process.exit`
  shim, while 3 e2e tests in `tests/shell.test.ts` spawn the CLI
  binary as a child process, pipe scripted commands via stdin, and
  assert on banner output, the not-logged-in hint, the unknown-command
  error, the `kanban`-prefix strip, and the on-disk history file.
- s-1092: ship the CLI runner end-to-end test, UX badge, and
  `finish()` contract fixes that close out the `kanban run` MVP.
  Backend migration 005 (sqlite + mysql) drops the
  `task_runs.runner_id → users.id` foreign key so the wire-format
  runnerId stays stable across claim / heartbeat / finish; `ClaimRun`
  now persists `req.RunnerID` verbatim, `version_map.go` gains a
  0.5.0 row that pins the migration counter at 4 (no schema delta vs
  0.4.0) so the e2e helper's fresh in-memory SQLite still gets
  migration 004, and `migrations_test.go` exercises both 005 up and
  down steps. New `backend/cmd/e2e-runner` binary is a test-only HTTP
  server with seeded admin + bot users, board, columns, two tasks,
  and a `READY <apiUrl> <adminToken>` readiness line that mirrors
  the production claim/heartbeat/finish/release/get + OAuth device
  flow + `/__test__/auto-approve` route surface. CLI gains
  `cli/tests/e2e/runner.test.ts` (spawns the helper, writes
  `.kanban-runner.yaml` + a node mock agent that exits 0, runs
  `kanban run --once`, and asserts the task advances from `todo` to
  `review` while the runner id surfaces in stderr), plus `test:e2e`
  and `test:unit` scripts in `package.json` so CI can split the
  suites. `cli/README.md` gets a new Runner section with quick
  start, both modes (board-bound and `--mine`), flag table,
  configuration discovery, signal handling, and a troubleshooting
  block covering the common 401/403/409 paths. Frontend renders a
  violet `🤖 <runnerId> · <elapsed>` badge on task cards while a CLI
  runner holds the task (polls `GET /api/v1/runs/:taskId` via the
  new `useTaskRun` hook with a 5s cadence), with a Vitest suite
  covering the claimed and null states.
- s-1093: ship the runner run-history surface end-to-end so ops and
  PMs can audit which runner ran which task, when, and how it ended.
  Closes the original v1 placeholder; the v2 scope it deferred has
  been delivered across sibling tasks s-1105 / s-1106 / s-1107 /
  s-1108 / s-1109 / s-1110 / s-1111. Backend (s-1107): repository
  method `RunRepository.ListRunHistory(filter RunHistoryFilter)`
  plus handler `handlers.ListRunsHistory(db)` exposing
  `GET /api/v1/runs/history`; supports `runnerId`, `status`
  (completed|failed|released), `boardId` (csv), `taskId`,
  `from`/`to` (RFC3339 or `YYYY-MM-DD`), `limit` (1–200, default
  50), `offset` (≥0, default 0); orders by `finished_at DESC` with
  `task_id ASC` as a stable tie-breaker; post-filters by column READ
  access for non-ADMIN callers (`canSeeRunRow` accepts either the
  snapshot `column_id` at claim time or the task's current column so
  rows remain visible after `CompleteTask` advances the task); ADMIN
  short-circuits the check; bad status / inverted time window /
  non-positive limit / negative offset return 400; returns `[]` not
  `null` on empty. Backend (s-1108): `FinishRun` now stamps
  the row in place — status=`completed|failed`, `finished_at`,
  `exit_code`, `error` — instead of issuing a `DELETE`, unifying the
  three terminal states (completed / failed / released) on the same
  "row stays" contract; migration 006 (sqlite + mysql) adds
  `idx_task_runs_finished_at` and
  `idx_task_runs_status_finished_at` to keep `/runs/history` cheap;
  `version_map.go` bumps the 0.6.0 entry to `From=1 To=6`. Frontend
  (s-1109): `frontend/src/pages/RunHistoryPage.tsx` consumes
  `runsApi.list` and renders a table (time, task title, runner,
  status, duration, error) with status / runner / date-range filters
  plus a search box matching task title, id, and runner id; lazy
  `/runs` route registered in `App.tsx`; `TaskRun` extended with the
  terminal statuses and `finishedAt / exitCode / error`; `runs.*`
  translation block added to `en.json` / `zh.json`; 9 Vitest cases
  cover loading, table render, status filter, search filter, both
  empty states, error+retry, and back link. CLI (s-1110):
  `kanban runs list [--runner-id] [--since <1d|2h|30m|1w|45s|abs>]
  [--status completed|failed|released] [--task <id>] [--board <id>]
  [--limit <n>] [--offset <n>]`; relative `--since` resolves to
  `?from=<now - dur>`; honours global `--output` (table / json /
  yaml); auth failures map to `NotLoggedInError` so the bootstrap
  exit-codes 2; new `FLAG_VALUES_PER_COMMAND` makes
  `runs list --status` offer the terminal run states instead of the
  default column states, wired into the bash / zsh / fish
  generators, the dynamic `__complete` runner, and the shell REPL;
  man page gains a "Run history" section; 25 new unit tests plus
  completion tests cover all of the above. Docs (s-1111):
  `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml` gains the
  `/runs/history` operation (`listRunsHistory`) under the existing
  `Runs` tag plus the `RunHistoryStatus` and
  `ListRunsHistoryResponse` schemas. Backend tests (s-1105): the
  eight per-case `TestListRunsHistory_*` functions are collapsed
  into one table-driven `TestListRunsHistory` with 19 subtests
  (happy path, `runnerId` / `status` / `boardId` filters, RFC3339 +
  `YYYY-MM-DD` time window, inverted / bad timestamp, single + csv
  `boardId` scope, viewer-vs-admin permission post-filter, empty
  result, pagination, unauthenticated), each seeding fixtures via a
  closure against the in-memory `setupRunsDB`. Migration test
  (s-1106): `TestSQLiteMigrationsTaskRunsUpDown` now walks the
  006 → 005 → 004 rollback chain and asserts that rolling back 006
  drops both history indexes while leaving the table + 004 indexes
  intact; the up-phase assertion also lists the history indexes so
  a regression in 006 surfaces as a single failing assertion. All
  v2 acceptance criteria from s-1093 are met: terminal
  (completed / failed / released) rows are queryable, READ and
  WRITE callers see the rows they have column access to, viewers
  without access get a 403-style filter, and the handler returns
  `[]` not `null` when the time window or filter set is empty.
- s-1112: ship per-flow Agent-identity selection in the OAuth device
  flow so `kanban run` always binds to an `users.type='AGENT'`
  bearer. `DeviceApproveRequest` now accepts an optional `agent_id`
  that resolves the bind target before falling back to the legacy
  global `oauth_device_agent_id` and then the human approver; the
  agent id is validated as an enabled AGENT row and gated by an
  ADMIN-or-owner permission check. `DeviceLookupHandler` adds
  `agent_selection_required` plus a role-filtered `available_agents`
  list for the browser page, and a new public
  `GET /oauth/device/agents` endpoint lets the page re-fetch that
  list. Consent rows and audit activities now key on the bound
  Agent id rather than silently overwriting the human approver's
  id. Frontend `OAuthDevicePage` renders an "Authorise as" selector
  (with "Myself" / per-Agent / server-default options) before the
  approve/deny buttons and posts the chosen `agent_id`; the
  `OAuthSettings` admin page adds the corresponding toggle.
  **Opt-in hardening:** the new
  `oauth_device_require_agent_selection` config key defaults to
  `"0"` so existing deployments keep the current "human approver
  binds" behaviour. When an admin flips it to `"1"`, the device
  flow rejects human-as-approver approvals with
  `400 invalid_request` (unless the approver is themselves
  `type='AGENT'`), enforcing the "CLI runner is for Agent use"
  hard requirement at the server boundary — review
  `devDoc/DEVICE_AUTH_AGENT_SELECTION_PLAN_2026-09-13.md`
  (plan §5 row 14) before enabling on production.
- s-1112.13: ship the device-flow-with-agent-selection CLI e2e
  test (plan §4.6). `cli/tests/e2e/agent-selection.test.ts` spawns
  the `kanban-e2e-runner` helper, drives `kanban auth login` end to
  end, has the helper's `/__test__/auto-approve` bind the pending
  device code to a seeded MEMBER Agent via the new optional
  `agent_id` body field, then asserts the JWT's `sub` is the Agent id
  and that `POST /api/v1/runs/claim` succeeds with the new bearer —
  covering the full OAuth 2.1 device-flow → identity-picker → JWT
  → /runs/claim chain. Helper seed extension adds `u-e2e-agent`
  (MEMBER role, type=AGENT) and `u-e2e-member` (MEMBER human) so
  the picker has both identities to choose from; the auto-approve
  endpoint now optionally accepts `agent_id` and validates the
  referenced user is an enabled AGENT row before binding. Backend
  `RequireAuth` middleware now resolves the user via
  `getCurrentUserFromRequest` (JWT first, kanban-token fallback) so
  device-flow access tokens work on every auth-protected endpoint,
  not just `/api/v1/users/me` and the WS handshake.

### Bug Fixes

- s-1100: validate the OAuth 2.1 JWT access token in `GetMe` and the
  WebSocket auth handshake. The device flow completed and the CLI
  stored a JWT, but `auth whoami` (and every other `/api/v1/users/me`
  call) still rejected the request with `Session expired. Run
  'kanban auth login' again.` because the handler handed the bearer
  straight to `getCurrentUserFromToken`, which only looks up opaque
  rows in the `tokens` table. The new `getCurrentUserFromRequest`
  resolves the user by trying `oauth.Signer.VerifyAccessToken` first
  and then falling back to the existing kanban-token / cookie path,
  so device-flow access tokens now work for `/api/v1/users/me`, the
  dashboard, the mine endpoint, and WS upgrades. Covered by
  `TestUsersMeAliasJWTBearer` (valid access JWT, unknown subject,
  expired JWT, tampered signature, kanban-token fallback).

### Improvements

### Documentation

#### Fixed
  - fix: tone down borders + the VIEWER badge in dark mode
  - fix: stop hiding more-menu icons in dark mode
  - fix: give SearchBar input explicit text + placeholder colors
  - fix: stop leaving bg-zinc-100/-50 buttons as 'whitish cards' in dark mode
  - fix: stop giving bg-zinc-200 secondary buttons white text in dark mode
  - fix: repair malformed Tailwind classes left over from dark-mode sweep
  - fix: keep SettingsPage tab in sync with the URL query string
  - fix: extend dark mode to all page wrappers, cards, borders, and text
  - fix: enable dark mode in Tailwind v4 via @custom-variant dark
  - fix: align OAuth page styles with the rest of the app
  - fix: add missing common.delete / common.save i18n keys
  - fix: default ALLOWED_ORIGINS
  - fix: some bug

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Fixed
  - fix: tone down borders + the VIEWER badge in dark mode
  - fix: stop hiding more-menu icons in dark mode
  - fix: give SearchBar input explicit text + placeholder colors
  - fix: stop leaving bg-zinc-100/-50 buttons as 'whitish cards' in dark mode
  - fix: stop giving bg-zinc-200 secondary buttons white text in dark mode
  - fix: repair malformed Tailwind classes left over from dark-mode sweep
  - fix: keep SettingsPage tab in sync with the URL query string
  - fix: extend dark mode to all page wrappers, cards, borders, and text
  - fix: enable dark mode in Tailwind v4 via @custom-variant dark
  - fix: align OAuth page styles with the rest of the app
  - fix: add missing common.delete / common.save i18n keys
  - fix: default ALLOWED_ORIGINS
  - fix: some bug

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Fixed
  - fix: tone down borders + the VIEWER badge in dark mode
  - fix: stop hiding more-menu icons in dark mode
  - fix: give SearchBar input explicit text + placeholder colors
  - fix: stop leaving bg-zinc-100/-50 buttons as 'whitish cards' in dark mode
  - fix: stop giving bg-zinc-200 secondary buttons white text in dark mode
  - fix: repair malformed Tailwind classes left over from dark-mode sweep
  - fix: keep SettingsPage tab in sync with the URL query string
  - fix: extend dark mode to all page wrappers, cards, borders, and text
  - fix: enable dark mode in Tailwind v4 via @custom-variant dark
  - fix: align OAuth page styles with the rest of the app
  - fix: add missing common.delete / common.save i18n keys
  - fix: default ALLOWED_ORIGINS
  - fix: some bug

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes
  - T-0001: MySQL setup wizard now auto-redirects to /setup on first boot; release-mode binary sets GIN_MODE=release so logs stay quiet; MySQL-only build forces the advanced form open so the DB config can't be skipped
  - T-0002: Consolidate all SQL migrations into a single initial schema (no more in-place upgrade path; fresh install only); MySQL startup self-heals missing tables (e.g. column_permissions on a DB created by a pre-consolidation build) instead of hard-failing
  - T-0003: /auth/init 400 on body double-bind fixed; kanban.env is now always written on init, with PORT and ALLOWED_ORIGINS lines present even when empty
  - T-0004: Column / board / oauth_consent handlers use portable REPLACE INTO instead of SQLite/PostgreSQL-only ON CONFLICT, so they work on MySQL too
  - T-0005: Admin role / enable changes invalidate every cached session for the target user, so the change is visible on the next request without logging out
  - T-0006: release.sh accepts a `backend [TARGETS...]` subcommand for backend-only cross-compile, skipping the frontend/MCP/web/skill steps

### Improvements

### Documentation

#### Fixed
  - fix: tone down borders + the VIEWER badge in dark mode
  - fix: stop hiding more-menu icons in dark mode
  - fix: give SearchBar input explicit text + placeholder colors
  - fix: stop leaving bg-zinc-100/-50 buttons as 'whitish cards' in dark mode
  - fix: stop giving bg-zinc-200 secondary buttons white text in dark mode
  - fix: repair malformed Tailwind classes left over from dark-mode sweep
  - fix: keep SettingsPage tab in sync with the URL query string
  - fix: extend dark mode to all page wrappers, cards, borders, and text
  - fix: enable dark mode in Tailwind v4 via @custom-variant dark
  - fix: align OAuth page styles with the rest of the app
  - fix: add missing common.delete / common.save i18n keys
  - fix: default ALLOWED_ORIGINS
  - fix: some bug

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Documentation
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add sqlite build tag for tests and add git version based migration
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.2.0]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add sqlite build tag for tests and add git version based migration
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update _count structure for tasks and add dropdown menuAbove option
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Fixed
  - fix: update filter panel tests to use proper dropdown interaction

#### Documentation
  - docs: update changelog [skip ci]
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add task sorting by position/priority/createdAt/title/assignee (T-1397)
  - feat: add comments and subtasks indexes migration

#### Documentation
  - docs: update changelog [skip ci]

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add comments and subtasks indexes migration

## [0.1.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add dark mode system preference listener [T-1294]
  - feat: add ColumnDetailPage route and ThemeSettings [T-1294]
  - feat: add fullscreen mode and copy task ID to TaskModal [T-1294]
  - feat: add taskId filter and createdByUsername to task API [T-1294]
  - feat: add includeDrafts and includeArchived params to task queries [T-1265]
  - feat: 完善看板功能和代码质量改进
  - feat: add move to column functionality and fix E2E tests
  - feat: add access_token column to attachments table for public access tokens
  - feat: add startup banner and GitHub link
  - feat: add GetBoard API, list_columns position filter, and unit tests

#### Fixed
  - fix: update AddTaskModal tests and use i18n for home page title [T-1294]
  - fix: correct WebSocket URL and improve hooks [T-1294]
  - fix: correct i18n key and add copy status feature [T-1294]
  - fix: move Agent Activity icon before More menu
  - fix: use robot icon for Agent Activity
  - fix: restore Agent Activity icon before More menu
  - fix: resolve task creation errors, improve WebSocket/rate limit config, and enhance UI/UX
  - fix: resolve task creation errors and improve UI/UX
  - fix: remove web build dist
  - fix(tests): add username column to subtasks_test.go schema
  - fix: exclude test files from TypeScript build checking
  - fix: show user nickname in column permissions

#### Documentation
  - docs: update changelog [skip ci]

## [beta-v0.1]

### Features

### Bug Fixes

### Improvements

### Documentation

#### Added
  - feat: add move to column functionality and fix E2E tests
  - feat: add access_token column to attachments table for public access tokens
  - feat: add startup banner and GitHub link
  - feat: add GetBoard API, list_columns position filter, and unit tests

#### Fixed
  - fix: move Agent Activity icon before More menu
  - fix: use robot icon for Agent Activity
  - fix: restore Agent Activity icon before More menu
  - fix: resolve task creation errors, improve WebSocket/rate limit config, and enhance UI/UX
  - fix: resolve task creation errors and improve UI/UX
  - fix: remove web build dist
  - fix(tests): add username column to subtasks_test.go schema
  - fix: exclude test files from TypeScript build checking
  - fix: show user nickname in column permissions

## [beta-v0.1]

