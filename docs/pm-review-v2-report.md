# PM Review V2 — Full-Page Inspection Report

> Task: s-1058 — Chrome DevTools MCP 全页面检查 V2
> Date: 2026-09-07
> Reviewer: PMReviewer (PM via opencode)
> Method: Playwright + manual code review (chrome-devtools MCP connection unavailable in the sandbox, so Playwright was used as a drop-in to drive Chromium for the same effect: screenshots, console-error capture, network-error capture, responsive viewports, dark-mode emulation).
>
> Screenshots captured to `.opencode/pm-review-shots/` (20 PNGs across desktop, mobile, dark-mode, and modal interactions).

---

## TL;DR — Issue Counts

| Severity | Count | Notes |
|---|---|---|
| P0 (blocking / data leak) | 4 | Need fix before release |
| P1 (major UX) | 11 | Strongly recommended |
| P2 (polish / consistency) | 14 | Nice to have |
| P3 (minor / style) | 8 | Backlog |

---

## P0 — Critical Issues (Block Release)

### P0-1. Internal UUID leaks into UI — Activity Log
**Where**: `frontend/src/pages/ActivityLogPage.tsx:314`
```ts
{t('settings.operator')}: {users[activity.userId] || activity.userId}
```
When the operator's user record can't be resolved (deleted user, agent, or insufficient permission to load user list), the raw `activity.userId` is rendered as-is — a 32-char hex string like `e95a04c50b5b541f1a83dacbe46db97a`. Visible in screenshot `10-activity-log.png`.

**Fix**: Show `t('common.unknownUser')` or `t('common.system')` when `users[activity.userId]` is missing.

---

### P0-2. Column `status` rendered as raw enum — leak of internal state to UI
**Where**:
- `frontend/src/components/Column.tsx:190` — `{showCopied ? t('column.copied') : column.status}` shows `todo`, `in_progress`, etc.
- `frontend/src/components/ColumnCard.tsx:78-80` — `{column.status}` shown verbatim
- `frontend/src/pages/BoardPage.tsx` (and ColumnBoard) — column header chip on every board
- `frontend/src/components/Column.tsx:330` — `columnName === t('task.status.done')` comparison will silently fail when the column is named differently

Visible in screenshots `05-board-sys.png`, `06-columns.png`. Also see `CompletedPage.tsx:73` which depends on `c.name === t('task.status.done')` for loading the "completed" list — this means **the completed page may return nothing** for boards that store the column name in English or in a different Chinese synonym.

**Fix**: Translate `column.status` to a localized label via a dedicated `columnStatusLabel(status, t)` helper. In `CompletedPage`, match on `column.status === 'done'` (the API enum) rather than translated column name.

---

### P0-3. WebSocket "connection lost" banner persistent & scary
**Where**: `frontend/src/components/WsWarning.tsx` + board page bottom banner
Visible in `05-board-sys.png` and `17-mobile-board.png` — `连接已断开 (重连中 (第N/10次)...) 立即重试` sits at the bottom-left of every board view, with no way to dismiss.

In normal dev environments (which is where most people will be), the MCP-server WS at `ws://localhost:8081/ws` legitimately isn't reachable, so the banner is **always on** in dev. PM concern:
1. Users will read this as a production bug.
2. On mobile the banner takes ~12% of vertical screen (`17-mobile-board.png`).
3. It cannot be dismissed — only fixed by clicking retry.

**Fix**: Auto-hide after a successful reconnect; make it dismissible; or split into two states: dev-mode silent log vs production-only visible warning.

---

### P0-4. Board name shows as numeric ID when no display name is set
**Where**: `frontend/src/components/BoardCard.tsx:37` and `frontend/src/components/BoardSelector.tsx`
The first board was created without a name (the test board is literally named "555", matching its `id`). No fallback, no validation in `CreateBoardModal`. The card title is `board.name`, the board-selector dropdown shows `555`.

PM impact: any user who skips the optional "name" field gets a card titled after the auto-generated ID. There is no warning.

**Fix**: When `name` is empty/blank, show `t('board.untitledBoard')` (e.g. "未命名看板") in the card and selector; show a small inline warning in `CreateBoardModal` that the field is recommended.

---

## P1 — Major UX Issues

### P1-1. Login page exposes "password (optional)" but then prompts for password if user already exists — confusing first-run flow
**Where**: `frontend/src/pages/LoginPage.tsx:96-108`
- `requirePassword` is toggled on when the backend returns the field for an existing user; the placeholder says "设置密码（可选）" while the field is now actually required.
- No "first-time user" affordance vs "returning user" affordance.

**Fix**: Replace the static label "设置密码（可选）" with a stateful hint: "首次设置密码" (first time) vs "请输入密码" (returning).

---

### P1-2. No global navigation menu / no header
**Where**: All authenticated pages
There is no shared top-level navigation. Users land on `BoardsPage` and have to know the magic URLs (`/columns`, `/drafts`, `/activity`, `/settings`, `/oauth-device`, `/agent-activity`). The "history" page links only via the board's overflow menu.

**Fix**: Add a header with primary nav: Boards · Columns · Drafts · Completed · History · Activity · Settings.

---

### P1-3. `App.tsx` registers both `/activities` and `/activity` for ActivityLogPage
**Where**: `frontend/src/App.tsx:69-70`
Two routes, one page. Likely a copy-paste artifact and confusing for SEO/bookmarks.

**Fix**: Keep one canonical route (`/activity`) and add a redirect from the other for backward compat.

---

### P1-4. Dark mode applied inconsistently — BoardsPage stays light under `prefers-color-scheme: dark`
**Where**: `frontend/src/pages/BoardsPage.tsx:274` background and card backgrounds
Verified via `22-dark-boards.png` — Playwright emulated `colorScheme: 'dark'` and the board detail page (`23-dark-board.png`) correctly applied dark tokens, but the BoardsPage (cards listing) did **not** darken. Yet the `<html>` element has the `.dark` class.

Likely cause: a Tailwind v4 purge issue or a wrapping div that strips dark-class context. Audit needed.

**Fix**: Inspect the rendered DOM in dark mode and ensure the outer wrapper passes the dark variant through.

---

### P1-5. Import button is repeated on every board card
**Where**: `frontend/src/components/BoardCard.tsx:110-118`
Import is a **global** action — clicking it opens the same modal regardless of which card triggered it. Putting it inside each card wastes space and misleads users into thinking import is per-board.

**Fix**: Move "Import" to the page-level toolbar (next to "新建看板") as a primary action.

---

### P1-6. Delete-board button has no accessible label
**Where**: `frontend/src/components/BoardCard.tsx:119-126`
Only a trash SVG inside a `bg-red-50` button. No `aria-label`, no text content. Fails screen-reader & keyboard-only navigation tests.

**Fix**: Add `aria-label={t('task.delete')}` (or "删除看板") and consider a visible tooltip on hover.

---

### P1-7. Empty `BoardCard` shows too many action buttons at once
**Where**: `frontend/src/components/BoardCard.tsx:48-90`
A single board card exposes 6 distinct controls: 进入 · 列管理 · 编辑 · 复制 · 另存为模板 · (CSV/JSON/Import/Delete). On the first run with one board this dominates the screen. On mobile (375 px wide) this wraps and looks like a button soup.

**Fix**: Move secondary actions behind an "..." overflow menu; keep only the primary "进入" + "列管理" + an overflow trigger visible.

---

### P1-8. `ColumnsPage` shows column `status` as raw enum and has no `新建列` button visible to non-admins
**Where**: `frontend/src/pages/ColumnsPage.tsx:412-423`
The add-column button is correctly gated by `(userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN')`. But:
- When the user is not an admin, **no message tells them why** the button is missing.
- The status badge next to each column shows the raw `todo` / `in_progress` (see P0-2).
- Drag-handle hint uses a generic circle icon (`dragHint`) that doesn't visually suggest "drag".

**Fix**: Show an info banner when the user lacks permission; translate status badges; replace the circle icon with an actual drag-handle glyph.

---

### P1-9. Mobile (375px) board header is cramped
**Where**: `frontend/src/pages/BoardPage.tsx` header section (verified in `17-mobile-board.png`)
Top bar shows: board name + view icon + search box + filter + create + actions + avatar. The "创建" button text wraps to two lines on a 375px viewport. The column-tab row also squeezes ("已完" is truncated to "已完").

**Fix**: On mobile: hide the board-selector dropdown content, collapse the search input behind a search icon, drop labels from the primary buttons.

---

### P1-10. `AddTaskModal` is missing ~5 expected fields
**Where**: `frontend/src/components/AddTaskModal.tsx`
The backend supports `assignee`, `tags`, `attachments`, `dueDate`, `agentPrompt` for tasks. The create modal only exposes title, description, board, column, priority, published.

**Fix**: At minimum add assignee & due date. Tags and attachments can remain "edit in detail modal" but should be discoverable from the card.

---

### P1-11. `TaskCard` shows raw task ID like `#5-1001` instead of a friendly reference
**Where**: `frontend/src/components/TaskCard.tsx:162`
`{String(task.id || '').slice(-6)}` → renders `#5-1001`. Looks like an internal code, not a reference number.

**Fix**: Render a kanban-style `T-123` reference (`#T-${sequence}`) using a dedicated `formatTaskRef(task)` helper.

---

## P2 — Consistency & Polish

### P2-1. Cards/buttons on BoardsPage use too many background colors (视觉噪音)
`BoardCard.tsx` uses 6 different colored chip backgrounds (blue, amber, purple, orange, emerald, sky, red) on a single card. It feels like 2015-era flat buttons.

### P2-2. The `dragHint` icon on `ColumnsPage` is a circle with an `i` — doesn't read as "drag"
Use a `≡` grip or two-dot handle.

### P2-3. `ActivityLogPage` exposes IP address to admins without a clear privacy disclosure
`activity.ipAddress` is shown raw (`IP: 192.168.x.x`). Consider a tooltip or copy-to-clipboard button.

### P2-4. `CompletedPage` filters by translated column name → breaks when locale differs from data
See P0-2. Even after fixing P0-2, the secondary filter "全部" only filters by board — no priority/assignee filter.

### P2-5. `DraftsPage` empty state is plain text — no illustration / CTA explanation
Could say "保存的草稿会自动出现在这里" with a tiny SVG.

### P2-6. `HistoryPage` is the same — minimal styling, no bulk action on the list

### P2-7. `SettingsPage` has no breadcrumb / no "you are here" indicator
Each tab is in URL but the tab UI looks like a flat menu rather than a section.

### P2-8. `SettingsPage` side-nav has duplicate `dark:bg-zinc-700` declarations
`hover:bg-zinc-50 dark:hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-700` — the `dark:bg-zinc-700` is applied unconditionally, contradicting the hover intent. Audit all sidebar tabs.

### P2-9. `HeaderRightMenu` dark mode toggle only shows sun/moon emoji — but emoji rendering varies by OS
Replace with explicit SVG glyphs (already done in `SettingsPage` sidebar).

### P2-10. `SearchBar` has no magnifying-glass icon — looks like a plain input
Add a leading icon, e.g. `<svg>` of search glass inside the input.

### P2-11. `Tasks` page (`/board/:id`) loading skeleton takes the full viewport
`Skeleton.tsx::BoardSkeleton` shows 5 column placeholders with 3 card placeholders each — feels heavy. Consider fewer skeletons.

### P2-12. `BatchOperationBar` is a fixed bottom bar but doesn't show "what will happen" preview
On batch delete the user must confirm twice. Add inline undo.

### P2-13. `LoginPage` has no logo / brand — only "Open kanban" text
For consistency with BoardsPage header, add the same blue-gradient icon.

### P2-14. No "favorites" / "recent boards" on `BoardsPage`
A board list of N cards with no sorting option. Add "last opened" sort.

---

## P3 — Minor / Style

### P3-1. "已完" instead of "已完成" on mobile column tab — text-clip with no ellipsis
Add `truncate` and a tooltip with the full name.

### P3-2. "另存为模板" button is long; breaks layout on narrow cards
Should be icon+text or split into an overflow menu (see P1-7).

### P3-3. BoardsPage footer GitHub link is too dim (`text-zinc-400`)
Either make it more discoverable or remove.

### P3-4. Drag-handle in `TaskCard` is three dots that overlap the priority dot
See `TaskCard.tsx:140-149` — drag indicator at left-1 collides with the priority dot at the title row.

### P3-5. Column header click-to-rename only shows pencil on hover; on mobile it never appears
Use `group-hover` plus `:focus-within` for keyboard users.

### P3-6. `TaskCard` uses `Untitled` (English) as fallback title even when locale is Chinese
Should be `t('task.untitled')` to match locale.

### P3-7. Loading spinner in column says "加载中..." with raw ellipsis
Use proper Unicode ellipsis `…`.

### P3-8. The settings page sidebar uses underline-style hover that doesn't match the rest of the app
Use the same card-hover style.

---

## Permission Visibility Audit

| Element | Visible to non-admin? | Correct? | Notes |
|---|---|---|---|
| 新建看板 button | ✅ yes | ✅ | Public |
| BoardCard "编辑" | ✅ yes | ⚠️ | Should be gated by `WRITE`/`ADMIN` board access |
| BoardCard "复制" | ✅ yes | ✅ | Public |
| BoardCard "另存为模板" | ✅ yes | ⚠️ | Should be gated by `ADMIN` |
| BoardCard "Import" | ✅ yes | ⚠️ | Should be admin-only |
| BoardCard "Delete" (trash) | ✅ yes | ⚠️ | Should be admin-only |
| Columns "新建列" button | conditional | ✅ | Correctly gated |
| Columns "permissions" button | conditional | ✅ | Admin-only |
| Settings "tokens" tab | conditional | ✅ | Admin-only |
| Settings "activities" tab | conditional | ✅ | Admin-only |
| Settings "agents" tab | conditional | ✅ | Admin-only |
| Settings "users" tab | conditional | ✅ | Admin-only |
| HeaderRightMenu "Logout" | ✅ yes | ✅ | Per-user |
| HeaderRightMenu "Language" | ✅ yes | ✅ | Per-user |
| HeaderRightMenu "Dark mode" | ✅ yes | ✅ | Per-user |
| ActivityLogPage `IP` & `source` | conditional | ✅ | Correctly admin-only |

**Summary**: 4 board-card actions should be permission-gated but are not. See P1-5, P1-6, P1-7.

---

## Error Handling & Toast Audit

- ✅ Backend errors are caught in `BoardsPage.fetchBoards` and a toast is shown ("保存失败", etc.).
- ✅ `ErrorToastContainer` is rendered on most pages.
- ⚠️ On 401 (token expired) the user gets a generic "请先登录后再操作" toast and stays on the page — there is no auto-redirect to `/login`. Most pages don't handle 401 at all and end up showing empty content with no explanation (e.g. `/activity` was empty when auth was missing).
- ⚠️ `ActivityLogPage` shows the literal error message `加载看板数据失败` even when there are no activities (it triggers when an unrelated fetch fails).
- ⚠️ `useBoardState` `loadError` is rendered inline with retry but never tied to a toast.

---

## Responsive Layout Audit

| Breakpoint | Issue |
|---|---|
| 375px (mobile) | Header cramped, "创建" button wraps, "已完" truncated |
| 768px (tablet) | Looks acceptable |
| 1024px (laptop) | Looks good |
| 1440px (target) | Looks good |
| 1920px+ | BoardsPage max-width is `7xl` (80rem = 1280px), so cards stay centered; could expand to use full width |

---

## Loading States & Skeleton Audit

| Page | Loading State | Quality |
|---|---|---|
| `BoardPage` | `BoardSkeleton` (5 columns x 3 cards) | OK but heavy |
| `BoardsPage` | None — just empty grid | Should show skeleton |
| `ColumnsPage` | Single line "加载中..." | Very thin |
| `CompletedPage` | Single line | OK |
| `DraftsPage` | None | Should show skeleton |
| `ActivityLogPage` | Uses `LoadingScreen` (full-page spinner) on first load; not on refresh | Mixed |
| `TaskModal` | `TaskModalSkeleton` lazy fallback | Good |

---

## Files Touched / Analyzed (for traceability)

Frontend source files inspected (all paths under `frontend/src/`):

- `App.tsx` — routing (P1-3)
- `main.tsx` — dark-mode init
- `styles/globals.css` — dark variant custom (P1-4)
- `pages/LoginPage.tsx` (P1-1)
- `pages/BoardsPage.tsx` (P1-4, P1-7, P2-1)
- `pages/ColumnsPage.tsx` (P1-8, P2-2)
- `pages/BoardPage.tsx` (P1-9)
- `pages/CompletedPage.tsx` (P0-2, P2-4)
- `pages/DraftsPage.tsx` (P2-5)
- `pages/HistoryPage.tsx` (P2-6)
- `pages/ActivityLogPage.tsx` (P0-1)
- `pages/SettingsPage.tsx` (P2-7, P2-8)
- `components/BoardCard.tsx` (P0-4, P1-5, P1-6, P1-7, P2-1)
- `components/Column.tsx` (P0-2, P3-5)
- `components/ColumnCard.tsx` (P0-2)
- `components/TaskCard.tsx` (P1-11, P3-4, P3-6)
- `components/AddTaskModal.tsx` (P1-10)
- `components/SearchBar.tsx` (P2-10)
- `components/BatchOperationBar.tsx` (P2-12)
- `components/HeaderRightMenu.tsx` (P2-9)
- `components/WsWarning.tsx` (P0-3)

---

## Recommended Fix Order

1. **Sprint 1 (this week)** — P0-1, P0-2, P0-4 (all 1-line fixes for state-leak bugs)
2. **Sprint 2** — P0-3 (WS banner), P1-2 (global nav), P1-5/6/7 (BoardCard cleanup)
3. **Sprint 3** — P1-8/9 (mobile layout), P1-10 (AddTaskModal), P1-11 (task ref)
4. **Backlog** — All P2 and P3 items

---

## How to Reproduce This Review

Screenshots in `.opencode/pm-review-shots/` (20 PNGs):

- `00-after-login.png` — board auto-redirect
- `04-boards.png` / `22-dark-boards.png` — BoardsPage light + dark (P0-4, P1-4, P1-7)
- `05-board-sys.png` / `17-mobile-board.png` / `23-dark-board.png` — BoardPage (P0-2, P0-3, P1-9)
- `06-columns.png` — ColumnsPage (P0-2, P1-8)
- `08-drafts.png` / `12-history.png` — list pages (P2-5, P2-6)
- `09-completed.png` — CompletedPage (P0-2, P2-4)
- `10-activity-log.png` — ActivityLogPage (P0-1)
- `13-settings.png` / `13b-settings-OAuth21.png` / `24-dark-settings.png` — Settings
- `18-task-modal.png` — attempted task-detail open (failed in headless run because the card click is hijacked by the bulk-select checkbox; needs interaction improvements)
- `20-add-task-modal.png`, `21-create-board-modal.png` — modal flows
- `16-mobile-boards.png` — BoardsPage on mobile (P2-13)

Reproduction script: `frontend/pm-review.mjs` (Playwright).
