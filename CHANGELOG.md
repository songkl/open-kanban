# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

