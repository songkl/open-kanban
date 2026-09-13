# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- s-1142: implement the external-IdP callback handler and the
  user-mapping algorithm promised in
  `docs/OAUTH_EXTERNAL_PLAN_s-1139.md` §3.3 / §4.4 / §5. The new
  `user_identities` table (migration 010, shipped for both SQLite
  and MySQL) records the binding between a local `users` row and
  an external IdP — columns `id` (ULID PK), `user_id` (FK to
  `users.id` `ON DELETE CASCADE` for GDPR parity), `provider_id`
  (FK to `oauth_providers.id` `ON DELETE CASCADE` so removing an
  IdP in the admin UI tears down all its bindings atomically),
  `subject` (the IdP-stable identifier — `sub` for OIDC, `id` for
  GitHub, etc.), `raw_claims` (JSON snapshot of the last IdP
  response so a future drift can be replayed without another
  round-trip — capped at 64 KiB and UTF-8-sanitised per the
  CLAUDE.md WebSocket-safety rule), `linked_at`, and
  `last_used_at`, with `UNIQUE(provider_id, subject)` as the
  natural key and `idx_user_identities_user` for the admin-side
  "list bindings for this user" view. The migration also adds
  `users.email` (nullable TEXT) with `idx_users_email` so the
  auto-link-by-verified-email path in the callback handler
  doesn't fall back to a table scan. The new `MapExternalIdentity`
  pure function runs the three-pass algorithm — pass 1 returns
  the existing identity row and refreshes `last_used_at` +
  `raw_claims`; pass 2 auto-links by verified email (refusing
  `AGENT` and `disabled` users per plan §4.4); pass 3 provisions
  a fresh `HUMAN` user with a random unguessable password (the
  column is NOT NULL so we have to write something), a
  collision-suffixed username, a 50-char nickname derived from
  the IdP display name / email local part / subject, the
  avatar URL, and the role from `extra_config.default_role`
  (default `MEMBER`, validated against the `users.role` CHECK
  allow-list). The new `ExternalCallbackHandler` serves
  `POST /oauth/external/:slug/callback` publicly (the whole
  point is to mint a session) and accepts either an `code`
  (delegated to the injectable `UserinfoFetcher`, default
  generic-OIDC implementation) or already-fetched claims in the
  body so the mapping algorithm is exercised end-to-end without
  standing up a real IdP. The handler mints a base64url-encoded
  kanban session token (distinct from the hex form used by
  `handlers.Login` so an audit log can spot the IdP-issued tokens
  at a glance), sets the `kanban-token` cookie, and returns the
  same envelope as `POST /api/v1/auth/login` plus a `binding`
  block that distinguishes `provisioned` / `linked` / `bound`
  for the SPA to render the right welcome-back vs new-account
  hint. CSRF state validation is intentionally not implemented
  here — it ships in sibling sub-task s-1145; the field is
  accepted on the request body and passed through to the
  fetcher for that work to pick up. 26 unit tests cover the
  three-pass algorithm, the auto-link guards (AGENT refused,
  disabled refused, unverified-email fall-through), the
  multi-IdP binding (one user, N identities), the cascade
  behaviour on user and provider delete, the 64 KiB /
  UTF-8 sanitisation, the collision-suffix loop, the
  slug-disabled → 404 contract, the handler happy-path,
  and the Bad-Gateway mapping for upstream IdP failures.
  `TestSQLiteMigrationsUserIdentities` round-trips the full
  up/down cycle on SQLite and pins column shape, default
  values, `UNIQUE(provider_id, subject)`, both `ON DELETE
  CASCADE` paths, and the `idx_users_email` lookup index.
  `VersionMigrationMap` gains a `0.10.0` entry mapping to
  migration 10.

- s-1140: ship the `oauth_providers` table as the schema foundation
  for the pluggable external-IdP login flow planned in
  `docs/OAUTH_EXTERNAL_PLAN_s-1139.md` §3.2. The new
  `oauth_providers` row carries the admin-facing fields promised in
  the plan — `id` (internal ULID PK), `provider_id` (URL-safe
  handle, UNIQUE, used as the path segment under
  `/oauth/external/<provider_id>/...`), `name` (login-button label),
  `type` (CHECK-constrained to
  `google|github|wecom|feishu|dingtalk|oidc` so the runtime dispatch
  table can't be smuggled typos), `enabled` (soft kill-switch),
  `position` (login-page render order), `client_id`, `client_secret`
  as `BLOB` for AES-256-GCM ciphertext (nullable for public-client
  providers that have no secret), `scopes`, `auth_endpoint` /
  `token_endpoint` / `userinfo_endpoint` / `issuer` (explicit
  overrides with empty-means-use-type-default convention),
  `extra_config` (type-specific JSON), `created_by` (`TEXT REFERENCES
  users(id) ON DELETE SET NULL` so deleting the admin doesn't
  delete every provider they configured), and `created_at` /
  `updated_at`. The `provider_id` UNIQUE backs the public route
  lookup; `idx_oauth_providers_enabled` backs the public
  "list enabled providers for the login page" query without a
  table scan once an admin accumulates disabled rows. Migration
  ships for both SQLite (006/008 mirror) and MySQL (explicit
  `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  to keep FKs to `users.id` from Error 3780'ing). The admin CRUD
  surface (s-1142), the AES-GCM helper (s-1141), the external IdP
  flow (s-1143+), `user_identities`, and `admin_audit_log` are
  intentionally separate sub-tasks per the plan's §8 breakdown —
  this tag is schema-only. `VersionMigrationMap` gains a `0.9.0`
  entry mapping to migration 9; the existing migration tests
  (`TestSQLiteMigrationsAgentCreatedBy`, `TestSQLiteMigrationsTaskRunsUpDown`)
  are updated from `m.Steps(-1)` to `m.Migrate(targetVersion)` so
  they stay correct when later migrations extend the tip, and one
  new test (`TestSQLiteMigrationsOAuthProviders`) round-trips the
  full up/down cycle and pins the column shape, defaults, UNIQUE
  on `provider_id`, CHECK on `type`, BLOB ciphertext round-trip,
  `ON DELETE SET NULL` on `created_by`, and the lookup index.

- s-1143: add the admin Settings → OAuth → Providers sub-tab on
  top of the existing `/api/v1/oauth/providers` CRUD endpoints
  from s-1141. The new `OAuthProvidersSettings` component renders
  a sorted list of providers with an inline `enabled`/`disabled`
  toggle switch, type / status / `secretSet` badges, and an
  add / edit modal with full client-side validation: `providerId`
  slug regex (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`), required
  `name` / `clientId` / `type`, scope tokens (`^[a-z0-9._:-]{1,64}$`),
  `http(s)` URLs (allowing `http://localhost`, `127.0.0.1`, `::1`
  for local dev), parsed-JSON `extraConfig`, and `issuer` required
  when `type === 'oidc'`. `providerId` is locked after creation
  (the public route key); `client_secret` is never displayed — only
  a "configured / not configured" badge — and is re-entered through
  a password-style input that the backend never returns (mirrors
  the OAuth client admin UX and avoids the secret leaking via
  devtools / screen-share / network tab). New API methods
  (`getOAuthProviders` / `getOAuthProvider` / `createOAuthProvider`
  / `updateOAuthProvider` / `deleteOAuthProvider`) and matching
  `OAuthProvider` / `OAuthProviderCreate` / `OAuthProviderUpdate`
  types. The admin OAuth Settings tab is admin-only and now exposes
  Providers alongside Apps / Permissions / Settings. 17 new
  frontend tests cover list rendering, badges, empty state,
  toggle, create / update payloads (including `clientSecret`
  omission), validation, cancel, delete, error display; the
  existing `OAuthSettings` tests gain admin-only visibility
  cases. i18n keys added to both `en.json` and `zh.json` for
  title, fields, validation errors, and per-type labels
  (`google` / `github` / `wecom` / `feishu` / `dingtalk` / `oidc`).

### Bug Fixes

- s-1134: fix `POST /api/v1/auth/agents` returning `500 {"error":"Failed to create"}`
  on dev builds. The migration runner used the tag-only `git describe`
  output (e.g. `0.2.0`) to look up `VersionMigrationMap`, which mapped
  `0.2.0` to migrations `1..2` and stopped there — so the s-1131
  migration `008_agent_created_by` (adding `users.created_by`) was
  never applied at startup. The `CreateAgent` handler then tripped
  `no such column: created_by` on every INSERT and translated it into
  the generic 500. The runner now detects "dev build" via the full
  `git describe --tags` output (carrying a `-N-gXXXX` suffix past the
  closest tag) and applies every embedded migration in that case,
  keeping the schema in sync with the application code under test.
  Production-tagged builds still honour `VersionMigrationMap` so
  operators retain explicit control over which migrations ship in each
  release. 1 new helper (`isDevGitBuild`) + 4 unit tests cover the
  detection rule, the dev-build migration path, idempotent re-runs,
  and the legacy fallback when no tag is present.
- s-1135: fix `/oauth/device` showing no Agent-identity picker on
  production builds. `GET /oauth/device/lookup` (s-1112.3) emits the
  selectable Agents as `available_agents` / `agent_selection_required`
  (snake_case, matching the rest of the OAuth wire contract), but
  `OAuthDevicePage` was still reading them as `agents` /
  `agentSelectionRequired` (camelCase). The field names never matched
  in production, so `hasAgents` was always false, the picker was
  always hidden, and the "Authorize as Agent" / server-default /
  empty-state UX shipped by s-1120 / s-1121 / s-1131 silently
  disappeared from real deployments — every existing test happened to
  mock the wrong key, so the suite still passed. The page now reads
  `available_agents` and `agent_selection_required` (with the old
  camelCase aliases kept as a defensive fallback so any leftover
  mocks / older payloads still resolve), the existing
  `OAuthDevicePage.test.tsx` suite is rewritten to use the real
  snake_case payload, and two new cases pin the regression: one
  asserts the picker actually renders when the lookup returns
  `available_agents`, the other asserts the legacy `agents` key is
  ignored so the page never silently falls back to it. `npm test`
  + `npm run build` both stay green (464/464 + `tsc && vite build`
  succeed); no backend / CLI / docs changes are needed because the
  server contract was already correct.

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
  **⚠ Opt-in breaking-warning:** the new
  `oauth_device_require_agent_selection` config key defaults to
  `"0"` so existing deployments keep the current "human approver
  binds" behaviour. **Flipping it to `"1"` is a breaking change**
  for any deployment that currently relies on a human approver
  completing the device flow without picking an Agent — the device
  flow will reject those approvals with `400 invalid_request`
  (unless the approver is themselves `type='AGENT'`). Use it to
  enforce the "CLI runner is for Agent use" hard requirement at the
  server boundary, but only after confirming that every CLI / MCP
  client is bound to an enabled AGENT identity. Review
  `devDoc/DEVICE_AUTH_AGENT_SELECTION_PLAN_2026-09-13.md` (plan
  §5 row 14) before enabling on production.
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

- s-1133: recover `kanban auth login` from a stale cached
  `client_id` instead of failing with `Login failed: unknown
  client_id`. When the OAuth server returns `invalid_client` /
  `unknown client_id` on the device authorization or token endpoint
  (because the operator restored a backup that pre-dates this
  registration, the `oauth_clients` row was pruned, or the DB was
  wiped between sessions), `runLogin` now clears the stored
  credentials and retries the device flow once with a freshly
  registered client. The retry path prints a yellow "re-registering"
  hint naming the rejected client_id before re-issuing the device
  code, so operators understand why a second browser prompt
  appeared. The new `isUnknownClientIdError` helper matches the
  canonical error from both the device authorization and token
  endpoints, and is exported for reuse. If the retry also fails the
  second error is surfaced verbatim. 3 new vitest cases cover the
  recovery branch, the failure-on-retry branch, and the helper's
  matching rules.
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

#### Added
  - s-1127: add the third-generation product review report at
    `docs/product-review-s-1127.md` covering user experience,
    feature completeness, UI consistency, performance,
    responsiveness, core user value, and prioritised improvement
    recommendations (6 P0 + 12 P1 + 7 P2). The report builds on
    `docs/pm-review-v2-report.md` (s-1058), tracks which items are
    still open from v2 (raw `column.status` leak, hardcoded WS port,
    dead components, etc.), adds the new "AI-first positioning"
    analysis for `kanban run` / MCP / device-flow with agent
    selection, and ends with a 12-week roadmap.
  - s-1136: add the first end-to-end CLI functional-test report at
    `docs/CLI_TEST_REPORT_s-1136.md`. Decomposes the CLI surface into
    16 sub-tasks (auth / status / dashboard / boards / columns / tasks
    / tasks batch / drafts / archived / comments / subtasks / mine /
    run / runs / workspace / shell+completion+config), captures the
    vitest run (778 / 778 unit + integration, 54 / 54 commands/run*,
    3 / 3 e2e agent-selection, 3 / 3 shell spawn, 2 / 6 e2e runner —
    pre-existing flake), and exercises every public subcommand against
    the running dev server. The report uncovers two backend bugs:
    `GET /api/v1/columns/:id` is not registered in
    `backend/cmd/server/main.go` (so `kanban columns get <id>` 404s
    even though `kanban columns list` shows the column), and
    `GET /api/v1/runs/history` is missing from the live build (so
    `kanban runs list` 404s). Two cosmetic issues are also logged:
    `kanban tasks get <unknown>` returns `exit 1` instead of the
    documented `exit 3` for `NotFoundError`, and
    `kanban columns list --positions abc` silently accepts bogus
    input. Adds `cli/.test-results/` to `cli/.gitignore` so future
    test sweeps do not pollute the repo; raw logs stay under
    `cli/.test-results/` for follow-up debugging.

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

