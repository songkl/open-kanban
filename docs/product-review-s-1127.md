# Product Review — kl-kanban (s-1127)

> **Reviewer:** PM via opencode
> **Date:** 2026-09-13
> **Repo root:** `/Users/kl/Documents/ai/kl-kanban`
> **Method:** Code review across `backend/`, `frontend/`, `cli/`, `mcp-server/`, plus `docs/pm-review-v2-report.md` and `CHANGELOG.md` for prior findings.
> **Scope:** holistic — UX, feature completeness, UI consistency, performance, value delivery, and prioritized improvements.
>
> This report *builds on* the existing [`docs/pm-review-v2-report.md`](./pm-review-v2-report.md) (s-1058, dated 2026-09-07). The "[open]" tag marks items still present; the rest are new observations or things that have changed in the last week of work (s-1092 → s-1126).

---

## Executive Summary

- **The product works, but it's a tools project that hasn't decided what kind of product it is.** It's marketed as "AI-first kanban for the AI era," but the experience layer is a fairly conventional Trello clone (boards → columns → cards) with an unusually complete CLI and MCP surface. The AI value surfaces only as optional `agentId` / `agentPrompt` fields on tasks, an OAuth-2.1 device flow, and a `kanban run` runner loop — none of which is obvious from the UI.
- **The core loop is solid but covered in technical debt.** Two big code-quality issues block scaling: a confirmed N+1 query in `GetColumns` (`backend/internal/handlers/columns.go:120-179`), and a hardcoded `ws://localhost:8081/ws` dev URL (`frontend/src/hooks/useBoardWebSocket.ts:57`) that lights up the orange "connection lost" banner on every fresh install.
- **The CLI / MCP story is genuinely strong.** OAuth 2.1 device flow, agent-identity binding (`s-1102`), shell completion, REPL, and run-history (`s-1093`, `s-1110`) are coherent, well-tested (34 vitest files + a dedicated `cmd/e2e-runner` test binary), and ahead of most competitors. This is the asset worth doubling down on for marketing/positioning.
- **UX has the bones of a polished tool but is held back by ~25 small inconsistencies** documented in pm-review-v2; the most user-visible are the rendered-raw-enum bug (`column.status = "todo"` shown as "todo" in the column header), the WS banner, and the orphan "555"-style board name fallback. None of these are hard; all are 1-3 day fixes.
- **"Team" is missing.** The README doesn't say team, the auth model is single-namespace, there's no invite/share flow, and `frontend/src/pages/BoardsPage.tsx:330` offers a "contact admin" dead-end when a user has zero board access. This is fine for "personal kanban with an AI client"; it makes the product un-runnable for the team-collab use case the description implies.

---

## 1. User Experience & Interaction Flow

### 1.1 First-run & onboarding
- **SetupPage** (`frontend/src/pages/SetupPage.tsx:79-598`) is genuinely well done — handles SQLite vs MySQL detection, persists `kanban.env`, polls for restart, defaults `ALLOWED_ORIGINS` to the current origin. The MySQL-only build correctly forces the advanced form open. Recently fixed in CHANGELOG (`T-0001`).
- **HomePage** (`frontend/src/pages/HomePage.tsx`) is **dead code** — exported but never imported by `App.tsx`. There's a `HomeRedirect` defined inline at `App.tsx:22-53` that does the same job. Recommend deleting `HomePage.tsx` to remove ~190 lines of duplicate onboarding logic and the implicit "two paths to the same UI" bug surface.
- **LoginPage** (`frontend/src/pages/LoginPage.tsx`) is intentionally minimalist: a single nickname input that may or may not reveal a password field based on server state. The placeholder says "设置密码（可选）" (set password (optional)) but once the backend has flipped `requirePassword=true`, the field becomes required without any label change. *See [open] pm-review-v2 P1-1.*

### 1.2 Boards / columns / tasks
- **Board listing** (`BoardsPage.tsx`, 451 lines) uses the **in-card `BoardCard` pattern with 6 visible controls per board** (enter / columns / edit / copy / save-as-template / CSV / JSON / Import / delete). On a 375 px viewport this wraps into a button soup. *See [open] pm-review-v2 P1-5, P1-7, P2-1.* Suggested pattern: primary action visible, secondary actions in an `⋯` overflow menu, page-level Import/Settings action.
- **BoardCard** also has a 6-color "chip" gradient on a single card (`BoardCard.tsx:91-127`) that reads as 2015-era flat design — visually noisy, no semantic differentiation.
- **BoardPage** is 561 lines and assembles 10+ subcomponents (`BoardSelector`, `BoardHeader` (which is *not* imported — see orphan component below), `BoardToolbar`, `BoardActionsMenu`, `HeaderRightMenu`, `WsWarning`, `KeyboardNavigation`, `BatchOperationBar`, `ColumnBoard`, `ConfirmDialog`). Of the components imported, **one is dead** (`BoardHeader` is in `components/index.ts:11` but never imported by any page), another is partially duplicated (`BoardSelector` vs `BoardHeader`'s inline dropdown), and three of them (`BoardToolbar`, `BoardActionsMenu`, `HeaderRightMenu`) are doing the same dropdown-control dance by hand. This is the right shape but should converge on a `Dropdown` primitive (already in the codebase as `CustomDropdown.tsx`).
- **Drag-and-drop**: `useSortable` from `@dnd-kit` is wired in `TaskCard.tsx` and the `updateTaskPosition` handler in `BoardPage.tsx:154-224` correctly does optimistic update + rollback on API failure. This works. **However:** with `transition: null` set on `TaskCard.tsx:130`, cards drop instantly (no animation) which feels jarring next to the `transition-all` everywhere else.
- **TaskModal** (`TaskModal.tsx`, 897 lines) is the single largest component in the codebase. It handles: title/desc/priority/assignee/agent/agentPrompt/status/column editing, markdown rendering with paste/drag image upload (`TaskModal.tsx:296-360`), comments with pagination at 10/page (`TaskModal.tsx:712-753`), subtasks, attachments, fullscreen toggle. Works but has visible rough edges:
  - `commentsPage` is local state, so opening a different task resets it (good) but switching comments pages loses the user's scroll position if they had it expanded (`TaskModal.tsx:238-242`).
  - The comments sidebar is `w-1/3 min-w-80` which on a 1440 px viewport becomes ~480 px of fixed width — eating almost 1/3 of the screen for a chat-style column.
  - "Add comment" only mounts the Markdown editor when `isEditing` is true (`TaskModal.tsx:769-788`). A user who isn't editing the task can't add a comment that contains markdown formatting. There's a fallback plain-text `<textarea>` (`TaskModal.tsx:795-799`) but it doesn't accept paste-as-image.

### 1.3 Task creation / detail
- **AddTaskModal** (`frontend/src/components/AddTaskModal.tsx`, 241 lines) — see [open] pm-review-v2 **P1-10**. Backend's `CreateTaskRequest` (`tasks_crud.go:31`) supports `assignee`, `agentId`, `agentPrompt`, `meta`, but the UI modal only exposes title, description, board, column, priority, published. A user has to open the task, click "edit", then assign it. **Tags** and **due dates** are *not* in the schema at all (`tasks` table in `001_initial_schema.up.sql:85-103`) — only `meta TEXT` is available, and `FilterPanelContent` uses `meta['标签']` (Chinese for "tag") as a string filter (`uiStore.ts:111`). This is fragile and only works in CN locale.
- **Task ID rendering** — see [open] pm-review-v2 P1-11. `TaskCard.tsx:216` shows `#5-1001` (last 6 chars of the UUID). For "task ref" this reads as garbage.

### 1.4 Permissions / 401 / global nav
- **401 handling**: `frontend/src/services/api.ts:75-78` hard-redirects to `/login` on any 401. This is correct for genuine auth expiry but rude when the issue is "no permission" — see 1.5 below.
- **No global header / no navigation menu** — see [open] pm-review-v2 P1-2. Users have to know magic URLs (`/drafts`, `/history`, `/activity`, `/oauth-device`, `/agent-activity`). The current "home" (`/boards`) buries the settings cog inside the user menu (`HeaderRightMenu`), and OAuth admin is buried one more click in `/settings?tab=oauth`. **This is the single biggest UX blocker for new users.**
- **Permission visibility** — see [open] pm-review-v2 "Permission Visibility Audit" table. 4 of 6 BoardCard actions (Edit, Copy, Save-as-Template, Import, Delete) are visible to non-admins. The user's expected affordance (button hidden) doesn't match the actual behavior (button visible, then 403 on click).

### 1.5 Empty / error states
- **No boards** (`BoardsPage.tsx:347-348`): renders a centered card with one CTA. Decent.
- **No permission to any board** (`BoardsPage.tsx:310-346`): renders a detailed card with "Contact admin" → `?tab=permissions` URL deep-link. **But `?tab=permissions` isn't a real tab in `SettingsPage.tsx:21`** (`ALL_TABS` doesn't include `permissions`), so the link goes to the default `profile` tab. PM-level smell — the CTA pretends to do something it doesn't.
- **Column with no tasks** (`Column.tsx:254-268`): a clickable empty state with a + icon. Good.
- **Empty draft / completed / history pages**: single line of text. See [open] pm-review-v2 P2-5, P2-6. These are first-impression pages for new users — they deserve a tiny illustration + CTA.

### 1.6 Mobile (375 px)
- See [open] pm-review-v2 P1-9. Board header is cramped (`"创建"` button wraps to two lines, `"已完"` is truncated to `"已完"`). No responsive variant of `BoardToolbar`, no hamburger menu, no nav drawer.
- The `@custom-variant dark (&:where(.dark, .dark *))` rule in `styles/globals.css:10` is correct for Tailwind v4 — but `BoardsPage.tsx:274` still renders `bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900` which doesn't fully cover the `100vh` background when content overflows. There's a subtle 1-px white seam at the bottom on some mobile screens.

### 1.7 Dead components
- `frontend/src/components/BoardHeader.tsx` — exported (`components/index.ts:11`) but **never imported**. The dropdown it implements is duplicated inline in `BoardSelector.tsx` and re-implemented inline in `BoardPage.tsx:381-393`. Recommend deleting `BoardHeader.tsx` or making it the canonical header.
- `frontend/src/pages/HomePage.tsx` — same situation, 193 lines of unreferenced code.

---

## 2. Feature Completeness & Practicality

### 2.1 Backend API surface — `backend/cmd/server/main.go:319-484`
The router is well-organized: `/api/v1/auth`, `/api/v1/boards`, `/api/v1/columns`, `/api/v1/tasks`, `/api/v1/comments`, `/api/v1/subtasks`, `/api/v1/templates`, `/api/v1/runs`, `/api/v1/dashboard`, `/api/v1/webhook`, `/api/v1/upload`, `/api/v1/workspace`, `/api/v1/archived`, `/api/v1/drafts`, `/api/v1/mcp/*`, plus `/oauth/*` and `/ws`.

What's present and good:
- Boards CRUD, copy, import/export (JSON/CSV), reset, from-template (`boards_*.go`).
- Columns CRUD with reorder + per-column agent binding (`columns.go`).
- Tasks CRUD + batch create/update/delete + archive/complete (`tasks_crud.go`, `tasks_batch.go`, `tasks_special.go`).
- Comments (`comments.go`).
- Subtasks (`subtasks.go`).
- Attachments (`attachments.go`) with 10MB / 10-file limits and progress (`FileUpload.tsx:24-36`).
- Activity log with IP + source (`auth_activity.go`).
- Templates (`templates*.go`).
- OAuth 2.1 (DCR + device flow + JWT + consents) — significant scope, well-tested (`oauth/*.go`, 14 test files).
- Runner API (`runs.go`, `runs/history`, claim/heartbeat/finish/release/get).
- Workspace file API (`workspace.go`) — text-file-only, used by agents to drop artifacts.
- Webhook notify endpoint (`webhook.go`) — receives `task.created` / `task.moved` / etc.
- Dashboard stats (`dashboard.go`).
- Permission system: board-level + column-level (`auth_permission_handlers.go`, `auth_column_permission.go`).
- User/Agent/Token management (`auth_user_handlers.go`, `auth_token_handlers.go`).

What's notably missing or weak:
- **Tags** — none in schema. Frontend filters by `meta['标签']` Chinese key (`uiStore.ts:111`).
- **Due dates** — none in schema.
- **Task dependencies / links** — no `depends_on` or `blocks` field. For a kanban tool meant to be operated by AI agents, this is a glaring gap — agents can't model "task B can't start until A finishes."
- **Watchers / subscriptions** — no notification endpoint beyond webhook. The `BroadcastTaskNotification` in `websocket_broadcast.go:137-150` only fires on create/update/move; there's no "task assigned to me" channel.
- **Recurring tasks / templates-with-schedule** — templates exist (`templates.go`) but there's no scheduling/cron layer.
- **Custom fields** — only the `meta TEXT` JSON blob, which is unindexable and unfilterable in SQL.
- **Soft-delete restore for boards** — `boards_reset.go` exists, but I see no "restore deleted board" UI on the History page. CLI has `archived restore` but not `board restore`.
- **Search** — `GetSearchTasks` exists (`tasks_query.go:166`), but the frontend `SearchBar` only triggers a local in-memory filter inside `useBoardState`, never the server endpoint. So full-text search across all boards is a no-op for the user.
- **Audit retention** — `activities` rows grow unbounded; no archival/purge path.
- **Pagination on `/api/v1/columns`** — handler returns all tasks inline (`columns.go:120-179`), no `page`/`pageSize`. The frontend has to fake pagination via `columnPagination` state (`useBoardState.ts:23-28`).

### 2.2 CLI surface — `cli/src/program.ts:182-1907`
30+ commands across `auth`, `status`, `dashboard`, `boards`, `columns`, `tasks`, `tasks batch`, `drafts`, `archived`, `comments`, `subtasks`, `mine`, `run`, `runs`, `workspace`, `shell`, `completion`, `config`, `agents`. This is unusually complete.

Strong points:
- **OAuth 2.1 device flow** with PKCE-less flow, browser fallback (`cli/src/auth/device-flow.ts`).
- **Agent identity binding** (`s-1102`) — `kanban auth agent {list,create,bind,delete}` lets CI runners hold an `AGENT`-typed token, so audit logs aren't flooded with admin noise.
- **Shell completion** for bash/zsh/fish with both static + dynamic `__complete` runner.
- **Interactive REPL** (`kanban shell`, s-1077).
- **Runner loop** (`kanban run`, s-1092) with mode-1 (board-bound) and mode-2 (`--mine` agent inbox), config discovery via walk-up `.kanban-runner.yaml` lookup, and a wizard (`kanban run init`).
- **Run history** (`kanban runs list`, s-1110) with `--since` (relative duration) + `--status` + `--task` + `--board` filters.

Weak points:
- **No `kanban attach <taskId>` interactive mode.** AI-agent use case is "I have a task, let me work it" — but `run` requires you to either watch a board or own an inbox. For ad-hoc "grab this one task" there's no flow.
- **`kanban moves`** (move a single task to another column) — exists (`tasks.ts`) but the README / user guide covers it minimally.

### 2.3 MCP server surface — `mcp-server/index.ts:22-55`
27 tools registered across `boards`, `columns`, `tasks`, `tasks batch`, `drafts`, `archive`, `comments`, `subtasks`, `dashboard`, `mytasks`, `upload`, `workspace`. **Discovery**: each is registered in `index.ts` and implemented under `tools/*.ts`. They mirror the CLI surface 1:1.

What's good:
- Device-flow OAuth bootstrap that prints `verification_uri` + `user_code` to stderr (`index.ts:79-94`).
- Type-safe wrapper around the same `OAuthClient` the CLI uses (`tools/helpers.ts`).

What's missing:
- **No "open the task detail in my browser" tool.** A reasonable AI agent wants to give the user a deep link after creating/moving a task. Tools emit IDs only.
- **No "summarize board" / "what's stuck" primitive.** The MCP server exposes raw CRUD but no analytical helper. For an "AI-first" tool, this is the obvious value-add.
- **No `watch_board(boardId)` / `subscribe(taskId)`** tool that wraps the WS API. The runner loop in the CLI has `claim/heartbeat/finish` but MCP agents have to poll.

### 2.4 README / docs
- `README.md` is up to date with the 0.6.0 schema (migration 006 in `version_map.go:48`), the OAuth 2.1 device flow, and the AI capability matrix. Good.
- `docs/CLI_USER_GUIDE.md` (896 lines, bilingual CN/EN) is excellent — onboarding flow, device-flow agent selection, troubleshooting. Recent additions for s-1102/s-1110 are merged.
- `docs/CLI_COMMANDS.md` (1297 lines) is a comprehensive flag reference. Searchable but very dense.
- `docs/pm-review-v2-report.md` exists and is detailed — but as of this review, **only ~3 of the 29 issues it flagged have been resolved** (mostly dark-mode sweep fixes from `CHANGELOG.md:198-209`). The P0-2 (`column.status` shown raw), P0-3 (WS banner), and P1-2 (no global nav) are still open.

---

## 3. UI Design & Visual Consistency

### 3.1 Design system
- **Tailwind v4** with `@tailwindcss/typography` and a single `@custom-variant dark` rule (`globals.css:1-15`). Tokens are CSS variables on `:root` / `.dark`. Reasonable.
- **No component library.** `frontend/src/components/` has 39 hand-rolled components. There's no shared `Button`, no shared `Modal` (there are 5+ nearly-identical modal wrappers), no shared `EmptyState`, no shared `Card`. Tailwind classes are duplicated 30+ times for the same pattern (e.g. `rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4` appears in 14 places).
- **Conventions drift.** Look at `BoardCard.tsx:29` (`rounded-2xl ... shadow-sm`) vs `TaskCard.tsx:164` (`rounded-xl ... shadow-sm`) vs `BoardsPage.tsx:310` (`rounded-2xl ... shadow-sm`). Three corners for "card," one for "panel." No design tokens document this.

### 3.2 Specific inconsistencies

| Where | Issue |
|---|---|
| `BoardsPage.tsx:274` | `bg-gradient-to-br from-zinc-100 to-zinc-50` page background |
| `BoardPage.tsx:354` | `bg-zinc-100` page background (no gradient) |
| `SettingsPage.tsx:117` | `bg-zinc-100` page background |
| `HistoryPage.tsx` | `bg-zinc-100` page background |

The board page is the only one *without* a gradient. Probably accidental.

| Where | Issue |
|---|---|
| `BoardCard.tsx:48` | Button text shadow + shadow on hover (`hover:shadow-md`) |
| `TaskCard.tsx:164` | `transition-all hover:shadow-lg hover:border-zinc-200` |
| `BoardsPage.tsx:300` | Primary CTA uses `shadow-lg shadow-blue-500/30` |

Two different elevations for "primary action" (colored shadow vs neutral shadow vs no shadow). Reader is left guessing which is the most important.

| Where | Issue |
|---|---|
| `Column.tsx:190` | Renders `column.status` raw — shows `todo` / `in_progress` / `done` to end users |
| `TaskCard.tsx:384` | `columnName === t('task.status.done')` — uses *localized* column name to decide if a checkmark renders |
| `CompletedPage.tsx:73` | `c.name === t('task.status.done')` — uses *localized* column name to decide if a task is "completed" |

This is the localization bug from [open] pm-review-v2 P0-2. **It silently breaks the `/completed` page in English.** A board with a column named "Done" in English won't show up because the filter compares against the Chinese localized "已完成" string.

| Where | Issue |
|---|---|
| `BoardCard.tsx:216` | `<h3 className="font-bold text-zinc-800 dark:text-zinc-100">` |
| `BoardsPage.tsx:284` | `<h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">` |
| `TaskModal.tsx:384` | `<h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">` |

Heading sizes are inconsistent (no shared scale: text-xl vs text-2xl vs default `text-base` for table headers in `DraftsPage.tsx`).

### 3.3 Dark mode
- Mostly works, but:
  - `HeaderRightMenu.tsx` emoji-only sun/moon toggle (per pm-review-v2 P2-9 — not fixed).
  - `useDarkMode.ts` (the hook) and `uiStore.ts` and `BoardPage.tsx` all independently initialize dark mode by reading `localStorage.getItem('darkMode')`. The hook in `BoardPage.tsx:40-43` will **race against** the `uiStore` initialization at `uiStore.ts:147-164`, leading to a flash on cold load.
  - `BoardPage.tsx:398` and `:448` use the redundant class `dark:bg-zinc-700 dark:hover:bg-zinc-700` (`dark:bg-zinc-700` is already set, so the hover variant cancels it).

### 3.4 Accessibility (low-effort audit)
- Most interactive elements have `title` but few have `aria-label`. Trash icon in `BoardCard.tsx:119-126` has no label. Sortable task cards have no keyboard alternative.
- `TaskModal.tsx` traps focus while open but I'm not certain it restores focus on close (didn't see a `useRef` for "previously focused element").
- Color-only differentiation: `priorityColors` in `TaskCard.tsx:24-28` uses red/yellow/green dots but no icon — fails WCAG 1.4.1.
- Comment timestamp in `TaskModal.tsx:718` says "5 minutes ago" via relative formatting — useful, but combined with no visible absolute date means a user can't tell when an old comment was actually posted.

---

## 4. Performance & Responsiveness

### 4.1 Backend — confirmed N+1 in `GetColumns`
`backend/internal/handlers/columns.go:103-210` issues **one query per column** to fetch its tasks, inside the column-fetch loop:

```go
for rows.Next() {                                  // ← for each column
    ...
    taskRows, err := db.Query(`SELECT … FROM tasks … WHERE t.column_id = ?`, col.BoardID, col.ID)
    ...
    defer taskRows.Close()                         // ← defer in a loop leaks the most-recent handle, doesn't close early
}
```

A 5-column board fires 6 queries (1 for columns + 5 for tasks). A 10-column board fires 11. On SQLite, this is "OK"; on MySQL over a network, this is 50-200 ms per column. **Plus** there's no pagination, so a column with 500 tasks returns all 500 rows inline. The client workaround is `LARGE_COLUMN_THRESHOLD = 50` in `Column.tsx:13` (only switches to `content-visibility: auto`), which isn't virtualization — it's a paint-time hint.

By contrast, the legacy `GetTasks` (`task_repository.go:67-208`) uses a single LEFT JOIN with subquery aggregation — correct. The fix is to mirror that pattern in `GetColumns` and ship tasks in one query.

### 4.2 Backend — `defer taskRows.Close()` inside loop
`columns.go:133` schedules the close when the *outer* function returns, not when the iteration ends. Under load with many columns, this leaks `*sql.Rows` handles until the request completes.

### 4.3 Backend — `idx_tasks_column_position` and `idx_tasks_column_archived` exist (`001_initial_schema.up.sql:295-296`), but the N+1 query on `t.column_id = ?` and `t.archived = false` is fine on those indexes. The fix is the query shape, not the indexes.

### 4.4 Backend — WS handler scaling
`backend/internal/handlers/websocket.go:65-79` holds all clients in a single map guarded by one `clientsMux sync.RWMutex`. `processBroadcast` (`websocket_broadcast.go:68-95`) walks the map under an RLock, releases, then iterates *without* the lock and writes per-conn with a per-conn mutex. That's correct. The `broadcastQueue` is a 1000-buffered channel with **silent drops** when full (`websocket_broadcast.go:60-64`). At >1000 broadcasts/sec this loses data with only a `slog.Warn` — the UI won't know.

### 4.5 Frontend — WebSocket dev URL points at the wrong port
`frontend/src/hooks/useBoardWebSocket.ts:57`:
```ts
if (import.meta.env.DEV) {
  return `ws://localhost:8081/ws`;
}
```
The backend listens on `PORT` (default 8080). `8081` is a dev-only test port used by `backend/internal/handlers/websocket_test.go:177`. There's nothing listening on `8081` in normal `npm run dev` workflows, so:
1. Every fresh install shows the orange "connection lost" banner on first render.
2. `WsWarning.tsx:9-12` always renders (because `wsStatus` starts as `'disconnected'`).
3. The fix is one line: change to `ws://localhost:8080/ws` (or use `window.location.host` like the prod branch on `:60`).

This bug was documented in [open] pm-review-v2 P0-3 and **still hasn't been fixed**.

### 4.6 Frontend — `taskRerun` polling every 5s per card
`useTaskRun.ts` polls `GET /api/v1/runs/:taskId` every 5s while a card is rendered (`TaskCard.tsx:113`). On a board with 50 visible cards this is 600 GETs/min *per connected user*. Acceptable for one user; the implementation should batch or use the WS broadcast instead.

### 4.7 Frontend — `useBoardState` re-fetch storms
`BoardPage.tsx:182-186` and `218-222` optimistically update local columns on every drag, then on API failure rolls back. On success, the WS handler (`useBoardWebSocket.ts:107-114`) also tries to refresh on the `refresh` broadcast — but it debounces by 1s if `lastLocalUpdateRef` was set. This works, but the debounce is per-render and the ref is per-mount; if the WS message arrives within the same React batch, it can be skipped. The fix is a real `setTimeout` debouncer or Web Locks.

### 4.8 Frontend — heavy `BoardPage` skeleton
`Skeleton.tsx:1-58` renders 4 columns × 3-4 cards = 13-16 pulsing rectangles for *every* navigation. Visible on first render only, but feels heavy.

### 4.9 Frontend — `BoardToolbar` → `FilterPanelContent` → `useFilters`
The search bar pushes the query to **both** `onSetSearchQuery` and `onSetFilters` (`BoardToolbar.tsx:64-72`), which then triggers the same `useBoardState` filter recompute twice per keystroke. Not catastrophic, but easy to dedupe.

### 4.10 Frontend — `react-virtual` installed but unused
`@tanstack/react-virtual` is in `frontend/package.json` but a grep for `useVirtualizer` returns nothing. With the `LARGE_COLUMN_THRESHOLD` of 50, columns above that scroll the whole DOM. Wiring up virtualization is the right move once `GetColumns` returns proper paginated data.

---

## 5. Core Feature User Value

### 5.1 The stated value proposition
> "A collaborative kanban board built for the AI era — empowering your AI assistants to handle tasks autonomously."
> — README.md:3

Translation:
- **"AI assistants handle tasks autonomously"** → implies agents can pick up tasks, work them, and post results without human intervention in the loop.
- **"collaborative"** → implies multiple humans can work in the same board.

### 5.2 Where the AI value actually surfaces today
1. **`kanban run`** (`cli/src/program.ts:1373-1462`, plans in `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`) — long-lived loop that polls for ready tasks, claims them, spawns an external agent binary, heartbeats, and finishes. Solid.
2. **OAuth 2.1 device flow** with agent-identity binding (`s-1102`, `s-1112`) — CI runners can hold a long-lived `AGENT`-typed token. This is the most non-trivial thing the product does, and it's invisible to web users.
3. **MCP server** (`mcp-server/`) — 27 tools, device-flow auth. AI agents can drive the board end-to-end through Claude/Cursor.
4. **Runner badge** on `TaskCard.tsx:68-92` — purple "🤖 runnerId · elapsed" pill while a task is claimed. Great UX signal, recent addition (s-1092).
5. **Webhook notify** (`backend/internal/handlers/webhook.go`) — but **the webhook is currently inbound-only**: external systems call `/api/v1/webhook/notify` to *trigger* a webhook send, no outbound webhook is configured anywhere. So this isn't delivering AI value yet.

### 5.3 Where the "collaborative" promise falls short
- No invite / share / join flow. The only way to add a teammate is admin-side via `/settings?tab=users` (`UsersSettings.tsx`) — admin types their nickname and creates them. There's no email, no link, no discovery. (`README.md` doesn't claim multi-user is supported, but the auth model implies it.)
- No notification on `@mention`. Comments don't trigger anything.
- `BoardsPage.tsx:330` "Contact admin" link 404s (no `permissions` tab).
- No "what changed since I last looked" feed. The Activity Log (`/activities`) shows admin-only audit rows; users have no equivalent.

### 5.4 The strongest deliverable today
The CLI + runner loop. If a user installs `open-kanban-cli@latest`, runs `kanban auth login` (OAuth device flow), creates an Agent in `/settings?tab=agents`, copies the token, writes a `.kanban-runner.yaml`, and runs `kanban run --mine`, they get a working AI agent worker in ~10 minutes. **This is the actual product story.** The web UI is a useful monitoring surface, not the primary user journey.

### 5.5 What isn't delivered
- **AI doesn't write back autonomously.** `kanban run` spawns an external agent binary — the agent has to implement the `AGENT_PROMPT` → result protocol itself. There's no built-in agent persona. For a "AI-first" product, this is the missing 10%.
- **No agent observability dashboard.** `ActivityLogPage.tsx` and `AgentActivityPage.tsx` exist and are good for human admins, but an agent operator needs: "what is my agent doing right now?", "did it fail?", "how long did the last 50 runs take?". `/runs` (`RunHistoryPage.tsx`) is the start of this, but doesn't aggregate metrics.
- **No memory / context passing between runs.** Each `kanban run` cycle starts cold. There's no "agent context" stored on the task that the next runner can read.

---

## 6. Improvement Recommendations (Prioritized)

> Format: **P0** = blocks release or data leak · **P1** = major UX/quality · **P2** = polish.
> Many of these were already flagged in [`docs/pm-review-v2-report.md`](./pm-review-v2-report.md). I've tagged each item with `[new]` (this review only), `[open]` (carried from v2), or `[wip]` (partially addressed).

### P0 — fix before any 1.0 / public launch

1. **[open P0-3 / new]** **Fix dev-mode WebSocket URL** — `frontend/src/hooks/useBoardWebSocket.ts:57` returns `ws://localhost:8081/ws`. Change to `ws://localhost:${window.location.port}/ws` or hardcode 8080. Same line exists in `AgentActivityPage.tsx:143`. Without this fix, every fresh install shows the orange "connection lost" banner and users think the product is broken. **Estimated: 5 minutes.**
2. **[open P0-2]** **Stop rendering `column.status` raw and stop filtering by localized name.**
   - `frontend/src/components/Column.tsx:190` — replace `{column.status}` with `{t(\`columnStatus.\${column.status}\`)}` (add the 4 keys: `todo`, `in_progress`, `review`, `done`).
   - `frontend/src/pages/CompletedPage.tsx:73` — replace `c.name === t('task.status.done')` with `c.status === 'done'` (the API enum, not the localized name). This is the bug that makes `/completed` show 0 results for English-named boards.
   - `frontend/src/components/TaskCard.tsx:384` — same `columnName === t('task.status.done')` smell.
   - **Estimated: 1-2 hours.**
3. **[new P0]** **Fix `GetColumns` N+1 + `defer` in loop** (`backend/internal/handlers/columns.go:103-210`). Single `SELECT ... FROM columns LEFT JOIN tasks ...` matching the pattern in `task_repository.go:67-208`. Drop the `defer` in the loop. Add a hard ceiling + `pageSize` (50) so a board with one 1000-task column doesn't ship 1000 rows on every render. **Estimated: half a day. Unblocks the "50 tasks per column" silent performance cliff.**
4. **[open P0-4]** **Board name fallback** — `BoardCard.tsx:38` and `BoardSelector.tsx` show the raw board name (which can be empty / a UUID). Add a fallback to "未命名看板" / "Untitled board" when the name is empty. The `CreateBoardModal` should warn if the user leaves the name blank. **Estimated: 1 hour.**
5. **[open P0-1]** **`activity.userId` fallback** — `frontend/src/pages/ActivityLogPage.tsx:314` renders the raw UUID when the user can't be resolved. Replace with `t('common.system')` / `t('common.unknownUser')`. **Estimated: 15 minutes.**
6. **[new P0]** **Delete dead code** — `frontend/src/components/BoardHeader.tsx` (151 lines, never imported) and `frontend/src/pages/HomePage.tsx` (193 lines, never imported). Future maintainers will keep "fixing" both. **Estimated: 30 minutes. Just delete them.**

### P1 — next sprint

7. **[open P1-2]** **Add a global header / navigation** — currently 8 routes with no shared chrome. Add a top bar with primary nav (Boards · Drafts · Completed · History · Activity · Settings). Replace the per-page "Settings" entry inside `HeaderRightMenu`. The audit table in pm-review-v2 documents exactly which menu items belong where. **Estimated: 2-3 days.**
8. **[new P1]** **Add `tags` and `dueDate` to schema.** Migration 008:
   ```sql
   ALTER TABLE tasks ADD COLUMN tags TEXT;            -- JSON array
   ALTER TABLE tasks ADD COLUMN due_date DATETIME;
   CREATE INDEX idx_tasks_due_date ON tasks(due_date);
   ```
   Then expose them in `AddTaskModal` and `TaskModal`. Replace the brittle `meta['标签']` lookup in `uiStore.ts:111`. **Estimated: 1-2 days (migration + UI + tests).**
9. **[new P1]** **Wire `/api/v1/tasks/search` to the UI.** Right now `SearchBar` only triggers an in-memory filter. The backend has a real full-text search (`tasks_query.go:166`). When the user types in the search box, debounce 250 ms, hit `/api/v1/tasks/search?q=...&boardId=...`, render results in a dropdown. **Estimated: 2 days.**
10. **[new P1]** **Add `kanban attach <taskId>` / "grab this one task" flow.** Today you must own a board column or an Agent inbox. For ad-hoc agents, expose a single-task claim: `POST /api/v1/runs/claim { taskId }` with the existing claim semantics, and `kanban attach T-123` on the CLI. **Estimated: 1 day. Closes a gap the AI-first pitch implies.**
11. **[new P1]** **Replace `useTaskRun` 5s polling with WS broadcast.** When `POST /api/v1/runs/claim` succeeds, broadcast a `task_run_started` message on `/ws` so all clients update in real time instead of polling. Saves ~600 GETs/min/user on a busy board. **Estimated: 1 day.**
12. **[open P1-5 / P1-7]** **Trim `BoardCard` to 2 visible actions.** Move Import / Save-as-Template / Duplicate CSV/JSON behind an `⋯` overflow menu. Move Import to the page toolbar (it's a global action). **Estimated: half a day.**
13. **[open P1-10]** **Add `assignee` + `dueDate` to `AddTaskModal`.** Currently users have to create → edit to assign. **Estimated: half a day.**
14. **[new P1]** **Build a small `Button` / `Modal` / `EmptyState` / `Card` component set.** Even just 4 primitives, used consistently, will cut the visual noise. The `frontend/src/components/index.ts` already exports `CustomDropdown`; add `Button`, `Modal`, `EmptyState`. Refactor `BoardsPage.tsx` / `BoardCard.tsx` / `SettingsPage.tsx` first. **Estimated: 1 week (spread across normal work).**
15. **[new P1]** **Permission-aware action buttons.** Audit (and fix) every "visible to all but 403 on click" affordance:
    - `BoardCard.tsx:64` Edit button → hide unless caller has `WRITE` or `ADMIN` on the board.
    - `BoardCard.tsx:81` Save-as-template → hide unless `ADMIN`.
    - `BoardCard.tsx:110` Import → hide unless `ADMIN`.
    - `BoardCard.tsx:119` Delete → hide unless `ADMIN`.
    - `TaskCard.tsx:284` Archive → already gated, confirm.
    **Estimated: half a day.**
16. **[new P1]** **Improve `RunHistoryPage` analytics.** Add a top strip: "Last 24h · 12 completed / 1 failed / 0 released · mean duration 4m 12s." This is what an agent operator actually opens the page for. **Estimated: 1 day.**
17. **[new P1]** **Reduce `TaskModal` size by extracting `<TaskHeader>`, `<TaskDescriptionEditor>`, `<TaskMetaPanel>`, `<TaskSubtasks>`, `<TaskAttachments>`, `<TaskCommentsSidebar>`.** 897 lines is the largest single component in the codebase and it'll keep growing. **Estimated: 2 days.**
18. **[open P1-9]** **Mobile responsive board header.** On `<768px`, collapse the board-selector text, hide the action button labels (icon only), and put the toolbar into a slide-up sheet. Use the `@tanstack/react-virtual` that's already in `package.json` for column virtualization. **Estimated: 1 week.**

### P2 — polish

19. **[open P2-1]** **Drop the 6-color chip pattern on `BoardCard`.** Two visual groups (primary / secondary) is enough. **Estimated: 2 hours.**
20. **[open P2-7 / P2-8]** **`SettingsPage` sidebar polish.** Add a "you are here" breadcrumb, drop the duplicate `dark:bg-zinc-700` declarations, fix the inconsistent hover treatment. **Estimated: half a day.**
21. **[open P2-12]** **`BatchOperationBar` should preview "X tasks will be moved to [column name] / deleted / archived" inline.** **Estimated: 2 hours.**
22. **[new P2]** **Add a `Reset password` flow** for users who lost their OAuth device approval. Currently the README's only escape is `kanban-server reset-password -user <nickname> -password <newpassword>` which requires server shell access. **Estimated: 1 day.**
23. **[new P2]** **Inbound webhook actually emits to subscribed URLs.** `webhook.go` currently exposes a manual `POST /api/v1/webhook/notify` for the admin to fire one-off. Add a `webhooks` table (URL + event filter) and have `tasks_crud.go` publish on task.create / task.move / task.complete automatically. **Estimated: 2-3 days. Big value for integrations.**
24. **[new P2]** **Add a CSV/JSON *import* preview** so users see what will be created before commit. Currently the modal uploads immediately and only shows a 409-conflict modal if there's a board-ID collision. **Estimated: 1 day.**
25. **[new P2]** **Add task watchers** (`task_watchers(task_id, user_id)`) so a user can subscribe to changes. Then expose a small "My Watched Tasks" view. Pairs well with #23. **Estimated: 2 days.**

---

## 7. Risks & Concerns

### R1. **Tech debt accumulation is outpacing refactoring.**
The project ships features in small commits (s-XXXX) at a fast cadence (~140 commits in 3 months per `git log --since="3 months ago"`). The PM review v2 (29 issues) shows the 5 P0 items are still open 6 days later. Recommendation: **explicitly close the v2 P0 list before merging new features.** A 1-2 day "tech-debt sprint" would close 80% of it.

### R2. **The "AI-first" positioning is currently aspirational.**
The product is a kanban with an unusually good agent API. Until `kanban run` is documented as a first-class user journey (and until the web UI shows agent activity alongside human activity, not just in a separate admin page), the marketing copy over-promises. Recommend: either tone down the README, or build the "AI sidebar" / "agent inspector" UI that makes the AI loop visible in the web app.

### R3. **Single-binary SQLite + WebSocket is fine for ≤50 users, but the WS handler holds one global mutex over the client map.**
At 1000+ concurrent clients the read-lock contention on `clientsMux.RLock` in `websocket_broadcast.go:69-74` will become measurable. The `redisConnectionCounter` is wired but not used for fan-out. Recommend: keep a `map[boardID][]*websocket.Conn` sharded by board so broadcasts only touch the relevant subset.

### R4. **`oauth_device_require_agent_selection` is opt-in by default.**
The new s-1112 hardening (`oauth_device_require_agent_selection="1"`) is off by default, so most deployments still see human approvers silently binding device-flow tokens. The current default favours backwards compat but quietly violates the "CLI is for agents" invariant the docs claim. Recommend: **flip the default to `1` for new installs** (gated on `users.type` count > 0 to avoid breaking single-user hobby installs) and document the migration in `CHANGELOG.md`.

### R5. **Schema changes lack a clear migration story for operators.**
Migrations 001-007 are clean SQL files, but the `version_map.go` table only goes to 0.7.0 (`version_map.go:53`) — the next migration would be 008, and there's no automation in `release.sh` to bump the map. Recommend: a CI check that any new `00X_*.sql` file forces a `VersionMigrationMap` entry.

### R6. **No SLO / no observability.**
There's structured logging (`slog` everywhere) but no metrics endpoint, no `/healthz` deep-check, no request tracing. The dashboard stats (`/api/v1/dashboard/stats`) only counts entities, not request rates. For a tool positioning itself for AI agents (which may fire bursts of 100s of calls), this is a gap.

### R7. **The CLI and MCP server don't share code via a library.**
Each reimplements the HTTP client wrapper (`cli/src/http/client.ts` vs `mcp-server/src/auth/client.ts` via `tools/helpers.ts`). Drift is likely. Recommend: extract a shared `@open-kanban/sdk` package and consume from both.

### R8. **`/api/v1/oauth/device/agents` is a public endpoint** (`backend/cmd/server/main.go:316`) gated only by `RequireAuth`. An authenticated user can enumerate all enabled Agents, which is intentional for the picker UI but should be documented in `docs/PERMISSION_MATRIX.md` (currently the matrix is empty for OAuth).

---

## 8. What's working well (call out for marketing)

- The **`kanban run` MVP** is genuinely shipped. End-to-end runner mode-1 / mode-2, claim/heartbeat/finish/release, history, agent-identity binding, and a separate `e2e-runner` test binary that exercises the whole chain. Most "AI kanban" projects ship a webhook + demo GIF; this one ships a working CI loop.
- **OAuth 2.1 done right.** DCR + device flow + JWT + agent-identity picker + audit rows + the optional strict-mode toggle. This is non-trivial work and it's tested (14 test files under `backend/internal/oauth/`).
- **Schema consolidation** (T-0002) was a smart call. Single source of truth, MySQL self-heals missing tables. Operators get one clean install path instead of an N-step upgrade.
- **i18n is wired in** (`en.json`/`zh.json` both 816 lines). Coverage is uneven (Chinese strings still leak into a few components like `MarkdownEditor.tsx:53` / `:63` / `:67` / `:79` "编辑/预览/Markdown 实时预览/暂无内容"), but the infrastructure is there.
- **Permission model is two-tier** (board-level + column-level) and tested. Most competitors only do board-level.

---

## 9. Recommended next-quarter roadmap

| Week | Theme | Deliverables |
|---|---|---|
| 1 | Tech-debt purge | Items P0-1 through P0-6 from §6 (~3 days) |
| 2-3 | AI value visibility | #10 (attach), #11 (WS for runs), #16 (run analytics) |
| 4 | Schema catch-up | #8 (tags + dueDate) + a tag-pill UI on TaskCard |
| 5 | UI primitives | #14 (Button/Modal/EmptyState/Card) |
| 6 | Navigation | #7 (global header) + #15 (permission-aware buttons) |
| 7-8 | Mobile + onboarding | #18 (mobile responsive), empty-state illustrations (#5 in §1.5) |
| 9-10 | Integrations | #23 (outbound webhooks), #22 (password reset), #24 (import preview) |
| 11-12 | Polish | P2 backlog + close out any open pm-review-v2 items |

---

## 10. Files & lines touched during this review (for traceability)

- Backend handlers: `backend/cmd/server/main.go`, `backend/internal/handlers/tasks_crud.go`, `tasks_query.go`, `tasks_mytasks.go`, `columns.go`, `comments.go`, `subtasks.go`, `websocket.go`, `websocket_broadcast.go`, `auth_rate_limit.go`, `webhook.go`.
- Backend data: `backend/internal/database/migrations/sqlite/001_initial_schema.up.sql`, `backend/internal/database/migrations/version_map.go`, `backend/internal/repositories/task_repository.go`, `backend/internal/services/task_service.go`.
- Backend models / OAuth: `backend/internal/oauth/*.go` (top-level only).
- Frontend pages: `frontend/src/App.tsx`, `frontend/src/pages/LoginPage.tsx`, `BoardsPage.tsx`, `BoardPage.tsx`, `HomePage.tsx`, `DraftsPage.tsx`, `CompletedPage.tsx`, `ActivityLogPage.tsx`, `AgentActivityPage.tsx`, `SettingsPage.tsx`, `SetupPage.tsx`.
- Frontend components: `TaskCard.tsx`, `TaskModal.tsx`, `AddTaskModal.tsx`, `BoardCard.tsx`, `Column.tsx`, `ColumnBoard.tsx`, `WsWarning.tsx`, `FileUpload.tsx`, `BoardHeader.tsx`, `BoardToolbar.tsx`, `SafeMarkdown.tsx`, `MarkdownEditor.tsx`, `Skeleton.tsx`, `ErrorToast.tsx`.
- Frontend hooks / store: `useBoard.ts`, `useBoardState.ts`, `useBoardWebSocket.ts`, `uiStore.ts`.
- Frontend services: `api.ts`.
- CLI: `cli/src/program.ts`, `cli/src/http/client.ts`.
- MCP server: `mcp-server/index.ts`, `tools/*.ts`.
- Docs / changelog: `README.md`, `CHANGELOG.md`, `docs/pm-review-v2-report.md`, `docs/CLI_USER_GUIDE.md`, `docs/CLI_COMMANDS.md`, `devDoc/PROJECT_IMPROVEMENT_DECISIONS.md`, `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
