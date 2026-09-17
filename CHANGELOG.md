# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features
  - feat: add column workflow trigger (migration 011) so column_agents.transition_trigger (none / on_enter / on_exit / both) fires the bound Agent automatically when a task crosses the column boundary (s-1214)
  - feat: extend columns management UI with a per-column Agent binding + auto-trigger toggle (s-1214)
  - feat: add per-user notification preferences (migration 012) backing a new "Notifications" section in Settings (s-1203, PM_REVIEW_2026-09-17 §3.7). Email and webhook delivery can be muted independently; webhook URL is editable and validated server-side
  - feat: add `GET` / `PUT /api/v1/auth/me/notification-preferences` endpoints with partial-PUT semantics (omitted fields preserved) so the Settings tab can flip one switch at a time
  - feat: move the Theme toggle into the top-right header (one click from any route) for s-1203, de-duping the toggle that used to live only in Settings → Theme
  - feat: hide the OAuth admin tab (client management + signing secret) from non-admin accounts (s-1203)
  - feat: add public read-only share link + iframe embed for boards (s-1204, PM_REVIEW_2026-09-17 §6): board owners mint a viewer token (migration 013, sha256-hashed at rest, plaintext returned exactly once) and get a sanitized `/public/b/:token` view that anonymous visitors can browse without logging in; mutation endpoints stay auth-gated so a leaked link never escalates into a write surface

### Bug Fixes
  - fix: fall back to the profile tab when a non-admin lands on `?tab=oauth` via a shared link (s-1203)

### Improvements
  - i18n: add settings.notifications.* keys (en + zh) for the new Notifications section
  - test: cover the new notifications-preferences endpoints (handler + migration), the admin-gated OAuth tab, the Notifications tab visibility, the theme toggle, and the partial-PUT contract
  - feat: make board header wrap and hide secondary buttons on mobile so the action bar fits at 375px (s-1192)
  - feat: add mobile icon-only filter and create buttons with 36px tap targets (s-1192)
  - feat: give mobile tab bar and column header 32px+ tap targets for counters, select-all and status badges (s-1192)
  - feat: add full-width mobile SearchBar with leading icon and 32px clear button (s-1192)
  - i18n: add filter.clearSearch key (s-1192)
  - test: add mobile layout tests for SearchBar, BoardToolbar, Column and a new ColumnBoard.test.tsx (s-1192)
  - feat: split task card assignee and last-runner semantics — the footer now renders a 👤 assignee chip and a separate 🤖 last-runner chip with explicit tooltips, and the task detail drawer surfaces both fields in their own labelled rows so operators can no longer mistake a Runner device name for the real owner (s-1202)
  - feat: add explicit "Created by" tooltip to the creator avatar on the task card so the previously unexplained avatar now reads as the task author (s-1202)
  - i18n: add taskCard.{assigneeBadgeTitle,assigneeBadgeAria,lastRunnerBadgeTitle,lastRunnerBadgeAria,createdByTooltip,unassigned} and taskModal.{assigneeFieldLabel,assigneeFieldUnassigned,lastRunnerFieldLabel} (s-1202)
  - test: cover the new task-card assignee/last-runner chips and the drawer people section (s-1202)

### Documentation

#### Added
  - feat: widen comments.content to LONGTEXT (migration 007) and document every 400 reason on POST /api/v1/comments (s-1018)
  - test: add migration_007_test.go covering long-content round-trip and up/down non-destructiveness

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

