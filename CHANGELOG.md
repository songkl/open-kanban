# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

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

