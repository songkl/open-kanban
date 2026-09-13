# Agent ↔ User Association — Creator Identification Design

**Task**: s-1137 — 规划：Agent 与用户关联 - 创建者识别机制
**Date**: 2026-09-13
**Status**: Design plan (awaiting sub-task creation)
**Depends on**: s-1131 (CLI auth login 身份选择与创建者识别) — partly shipped

---

## 1. Hard Requirement

> Every Agent identity in `users` MUST be traceable to exactly one
> **human** account that owns it; ownership must survive the human's
> role / enabled / display-name changes, must be retrievable through
> both REST endpoints and CLI commands, and must not be silently
> rewritten by any other code path.

Why:

- **Audit.** When an Agent posts a comment, claims a task, or binds
  to an OAuth device code, operators must be able to answer "who
  deployed this Agent?" without grepping access logs.
- **Delegation.** The device-flow approver list (s-1112 / plan
  §4.1.2) needs `createdBy` to gate which humans can authorise as
  which Agents.
- **UX.** `kanban auth agent list` already renders a "Created by"
  column (s-1131); the page that the human visits when they bind a
  device code needs the same data to disambiguate Agents with the
  same nickname.
- **Lifecycle.** Deleting the creator must NOT cascade-delete the
  Agent. The Agent becomes "orphaned" — visible, identifiable, and
  re-parentable by an ADMIN.

The hard requirement is implemented at the **schema layer**
(`users.created_by`, migration 008) and at the **creation layer**
(`CreateAgent` stamps `user.ID` on insert). This document covers
what's wired, what's still TODO, and the test plan.

---

## 2. Current State (as of 2026-09-13)

### 2.1 Schema — `users.created_by` is live

`backend/internal/database/migrations/{sqlite,mysql}/008_agent_created_by.up.sql`
adds a nullable `created_by TEXT REFERENCES users(id) ON DELETE SET NULL`
column plus an `idx_users_created_by` index.

Properties:

| Property | Value | Reason |
|---|---|---|
| Nullable | yes | Pre-existing AGENTs have no creator on file; HUMAN rows must remain NULL. |
| FK target | `users(id)` | A creator is itself a `users` row, usually `type='HUMAN'`. |
| `ON DELETE` | `SET NULL` | Deleting the creator must NOT cascade-delete the Agent. |
| Indexed | yes (`idx_users_created_by`) | Query "agents I created" runs from every Agent manager UI. |

The FK + index pair was deliberately **not** added in migration 001
because we did not yet know whether the owner field should be a
foreign key, a free-text username, or a separate `agents` table. The
2026-09-13 refactor (s-1131) settled on the FK design.

### 2.2 Backend handler — `GetAgents` returns creator metadata

`backend/internal/handlers/auth_user_handlers.go:328-389`
(`GetAgents`) joins `users u` with `users cb` on `cb.id = u.created_by`
and exposes three fields per row:

```json
{
  "id":                "agent-1",
  "nickname":          "opencode-bot",
  "avatar":            "...",
  "type":              "AGENT",
  "role":              "MEMBER",
  "enabled":           true,
  "createdAt":         "...",
  "updatedAt":         "...",
  "lastActiveAt":      "...",
  "tokenCount":        1,
  "createdBy":         "admin-1",
  "createdByNickname": "Alice Admin",
  "createdByUsername": "alice"
}
```

The three `createdBy*` fields are **only present when the underlying
`created_by` is non-null** — pre-existing rows and HUMAN rows omit
the keys entirely. The test in
`backend/internal/handlers/handlers_user_test.go:1168-...` covers
both the present and absent cases.

### 2.3 Backend handler — `CreateAgent` stamps the creator

`backend/internal/handlers/auth_user_handlers.go:397-488`
(`CreateAgent`) writes `created_by = user.ID` on INSERT and returns
`"createdBy": user.ID` in the response payload. The same handler
auto-grants `ADMIN` board permissions on every non-deleted board so
the new Agent can immediately claim tasks.

### 2.4 CLI — `kanban auth agent list` renders the column

`cli/src/commands/agents.ts` parses the `createdBy` / `createdByNickname`
/ `createdByUsername` fields and renders a "Created by" column. When
the server omits creator info (legacy 007-or-earlier build), the CLI
gracefully hides the column and labels individual rows as `(legacy)`
— covered by `cli/src/commands/agents.test.ts:215-...`.

### 2.5 What is still missing

| Need | Currently | Plan section |
|------|-----------|--------------|
| `GET /api/v1/auth/users/{id}/agents` — list agents owned by a user | ❌ not implemented | §4.2 |
| `GET /api/v1/auth/agents/{id}` — single-agent detail incl. creator | ❌ not implemented | §4.3 |
| `PATCH /api/v1/auth/agents/{id}/owner` — re-parent an orphaned Agent | ❌ not implemented | §4.4 |
| `createdBy` on `tasks.created_by`-style denormalised reads | ⚠️ only via `tasks.created_by`, not for Agent actions | §4.5 |
| Creator-gated permission: only ADMIN or `created_by == user.id` can `auth agent reset-token` / `delete` | ❌ any admin | §4.6 |
| CLI: `kanban auth agent list --owner <username>` filter | ❌ not implemented | §4.7 |
| Frontend Agent-manager page: "Created by" column + orphan badge | ⚠️ only the Agents settings page exists; no standalone manager | §4.8 |
| Audit: activity log entry whenever `created_by` is rewritten | ❌ not logged | §4.9 |

---

## 3. Goal

After this design ships:

1. **Every Agent row carries a non-null `created_by`** for Agents
   created post-008. Pre-008 Agents stay NULL until an ADMIN runs a
   one-off re-parent tool, after which they too carry a creator.
2. **`GetAgents`, `GetAgentByID`, `GetAgentsByOwner`** are the three
   public read endpoints. All three return the same `createdBy*`
   fields and 200 + empty array on no results.
3. **Ownership is re-parentable**: an ADMIN can assign an Agent to a
   new human creator via `PATCH /auth/agents/{id}/owner`; the change
   is recorded in `oauth_activity` so audits can trace it.
4. **The CLI surfaces ownership** in `list` and `show`, and the
   `agents` admin page renders "Created by" + an "Orphaned" badge
   when `created_by IS NULL`.
5. **The creator (or any ADMIN) has special permissions** on their
   own Agent — `reset-token`, `delete`, and `re-parent` — without
   needing global ADMIN. MEMBERs/VIEWERs cannot touch Agents they
   did not create.

---

## 4. Detailed Modification Plan

### 4.1 Data model (no schema change required)

The `users.created_by` column added in migration 008 already meets
the hard requirement. No further DDL is needed for phase 1.

Phase 2 (out of scope, listed in §6): consider promoting Agents to a
separate `agents` table when we add per-Agent rate limits / quotas.

### 4.2 `GET /api/v1/auth/users/{id}/agents`

- Path: `/api/v1/auth/users/:id/agents`.
- Auth: `handlers.RequireAuth(db)`.
- Visibility:
  - Caller is ADMIN → sees every Agent owned by `:id`.
  - Caller is the same human (`user.id == :id`) → sees their own
    Agents.
  - Anyone else → 403.
- Response: same shape as `GetAgents` (the array slice), so the
  frontend can reuse the rendering component.

SQL:

```sql
SELECT u.id, u.nickname, u.avatar, u.type, u.role, u.enabled,
       u.created_at, u.updated_at, u.last_active_at,
       u.created_by, cb.nickname, cb.username,
       (SELECT COUNT(*) FROM tokens WHERE user_id = u.id) AS token_count
FROM users u
LEFT JOIN users cb ON cb.id = u.created_by
WHERE u.type = 'AGENT' AND u.created_by = :id
ORDER BY u.created_at DESC
```

Empty result returns `{"agents": []}` (200, never 404 — the user
may simply have no Agents).

### 4.3 `GET /api/v1/auth/agents/{id}`

- Path: `/api/v1/auth/agents/:id`.
- Auth: `handlers.RequireAuth(db)`.
- Visibility: same rule as 4.2. The handler returns the row directly
  (no array wrap); 404 when `:id` is not an `AGENT` row.
- Use case: the CLI's `kanban auth agent show <id>` and the
  frontend Agent-detail drawer.

### 4.4 `PATCH /api/v1/auth/agents/{id}/owner`

- Body: `{"newOwnerId": "<user-id>"}`.
- Auth: ADMIN only in phase 1 (per s-1112 delegation follow-up).
- Behaviour:
  1. Validate `newOwnerId` exists and is `type='HUMAN'` and
     `enabled=true`. Reject otherwise (400 / 422).
  2. `UPDATE users SET created_by = ?, updated_at = ? WHERE id = ?`
     (the old owner stays the same; we record the change in
     activity — see 4.9).
  3. Invalidate `permissionCache` for the Agent so downstream
     checks reflect the new owner.
- Re-parenting a NULL owner (orphan) is the primary use case.

### 4.5 Denormalised reads — Agent-scoped endpoints

For consistency with `tasks.created_by` (already denormalised into
the task list / detail / run endpoints at
`backend/internal/handlers/tasks_mytasks.go:80-190`,
`tasks_run.go:1017-1051`), Agent-issued reads should expose the
creator in their payloads:

- `GET /api/v1/tasks/{id}` — when the task was last touched by an
  Agent (`agent_id IS NOT NULL`), include `createdBy` / `createdByUsername`
  on the **Agent** that acted, not just on the task's `created_by`.
- `GET /api/v1/runs/{id}` — include `agentCreatedBy` so the CLI
  runner page can show "alice-bot (created by alice)".

Phase 1 scope: add `agentCreatedBy` only on the `runs/{id}` payload,
where the join already exists.

### 4.6 Creator-gated permissions

Today, `ResetAgentToken` and `DeleteAgent` (auth_user_handlers.go:490+,
:543+) check `isAdmin(user)` only. We extend both:

```go
allowed := isAdmin(user) || (agent.CreatedBy != nil && *agent.CreatedBy == user.ID)
if !allowed {
    c.JSON(http.StatusForbidden, gin.H{"error": "..."})
    return
}
```

This means: a human can reset / delete their own Agent without
being an ADMIN. The "last admin" guard at line 521-531 still applies
(only enforced when the **Agent** has `role='ADMIN'`, not the
**caller**).

For MEMBERs: they can only act on Agents they created. AGENT-type
users cannot reset their own token (they must use the long-lived
agent-token path; see `auth agent reset-token` semantics in s-1102).

### 4.7 CLI — `kanban auth agent list --owner <username>`

`cli/src/commands/agents.ts` parses the optional `--owner` flag and
adds a query string:

```
GET /api/v1/auth/agents?owner=<username>
```

The handler accepts the new `owner` query parameter and joins
through `users cb`. Empty results stay a 200 with the empty array.
Tests in `cli/src/commands/agents.test.ts` cover:

1. No `--owner` → server-side default (all Agents).
2. `--owner alice` → server filters to Agents whose creator
   username is `alice`.
3. Unknown owner → server returns `{agents: []}`, CLI prints a
   friendly "(no agents owned by <username>)" line.

### 4.8 Frontend — Agent-manager page

The existing `frontend/src/components/OAuthSettings.tsx` shows
Agents in a sub-panel. We extend:

- Each row renders a "Created by" column (`createdByNickname` +
  `createdByUsername`).
- Rows where `createdBy` is absent get an "Orphaned" badge with a
  "Re-parent" button that opens a modal listing enabled HUMAN users.
- The "New Agent" form is unchanged (it still stamps the current
  user as creator).

i18n keys (en + zh):

- `agents.column.createdBy` — "Created by" / "创建者"
- `agents.badge.orphaned` — "Orphaned" / "无主"
- `agents.action.reparent` — "Re-parent" / "更换创建者"
- `agents.empty.owner` — "No agents owned by {owner}" / "{owner} 未创建任何 Agent"

### 4.9 Audit logging

Every write path that mutates `users.created_by` must record an
activity row. Phase 1 uses the existing
`backend/internal/handlers/auth_activity.go` infrastructure:

| Action | Recorded as | Payload |
|--------|-------------|---------|
| `CreateAgent` | `auth.activity.action = 'agent.create'` | includes `createdBy: user.ID` |
| `PATCH /auth/agents/{id}/owner` | `auth.activity.action = 'agent.reparent'` | includes `oldOwner`, `newOwner` |
| `DeleteAgent` | `auth.activity.action = 'agent.delete'` | includes `createdBy` at deletion time |

The activity log is therefore the authoritative source for "who
re-parented Agent X and when", even if the `users.created_by` column
has been overwritten.

---

## 5. Test Plan

### 5.1 Backend — handler-level (`*_test.go` in `handlers/`)

Table-driven test for the new endpoints, using the existing
`:memory:` SQLite fixture:

| Case | Setup | Expectation |
|------|-------|-------------|
| `GetAgentsByOwner` happy path | 2 agents owned by alice, 1 by bob | 200, only alice's returned |
| `GetAgentsByOwner` empty | alice owns nothing | 200, `{"agents": []}` |
| `GetAgentsByOwner` foreign caller (MEMBER) | bob querying alice | 403 |
| `GetAgentByID` happy | agent exists, owned by alice | 200 with `createdBy*` |
| `GetAgentByID` not found | unknown id | 404 |
| `GetAgentByID` non-AGENT row | human id | 404 |
| `ReparentAgent` happy | ADMIN moves agent → alice | 200, `created_by` updated, activity row recorded |
| `ReparentAgent` new owner is AGENT | new owner has `type='AGENT'` | 422 |
| `ReparentAgent` new owner disabled | `enabled=0` | 422 |
| `ReparentAgent` caller is MEMBER | non-admin caller | 403 |
| `ResetAgentToken` by creator | alice resets her own agent | 200 |
| `ResetAgentToken` by other MEMBER | bob resets alice's agent | 403 |
| `DeleteAgent` by creator | alice deletes her own agent | 200 |
| `DeleteAgent` last-admin guard | alice's agent is the last enabled ADMIN | 400 |

### 5.2 Backend — handler-level integration test (extension)

Extend `handlers_user_test.go:1168` (`TestGetAgentsHandler`) to
also assert:

- `createdBy` omitted on pre-008 agents (seeded without the column).
- `createdByNickname` resolves the nickname (LEFT JOIN).
- `createdByUsername` resolves the username (LEFT JOIN).

### 5.3 CLI — `agents.test.ts`

New sub-tests:

1. `--owner alice` filter — server stub returns 2 Agents owned by
   alice, 1 by bob; CLI prints only alice's.
2. `--owner unknown` — server returns `{agents: []}`; CLI prints the
   "(no agents owned by unknown)" hint.
3. `kanban auth agent show <id>` — server stub returns a single
   Agent; CLI prints the table including creator info.

### 5.4 Frontend — `OAuthSettings.test.tsx` (or new
`AgentManager.test.tsx`)

1. Renders "Created by" column when `createdBy` present.
2. Renders "Orphaned" badge when `createdBy` absent.
3. Re-parent modal opens on badge click and POSTs
   `PATCH /auth/agents/{id}/owner`.
4. Re-parent rejects when the selected user is `type='AGENT'`
   (frontend guard mirroring the 422 from §4.4).

### 5.5 Migration smoke test

The migration runner test
(`backend/internal/database/migrations_test.go`) must cover:

- Fresh DB at version 0 → migrates to 008; `users.created_by` column
  exists and is nullable.
- DB at version 007 → upgrade runs the ADD COLUMN + CREATE INDEX in
  a single transaction.
- DB at version 008 → `down.sql` drops the column and the index.

### 5.6 Backwards compatibility

- All new endpoints are additive. Existing clients keep working.
- The `createdBy*` fields are absent (not null) on legacy rows, so
  the JSON shape is forward-compatible: old clients ignore unknown
  keys.
- The `createdBy` permission grant in §4.6 is a **superset** of the
  current ADMIN-only rule — no caller loses access.
- The CLI `--owner` flag is optional; omitting it preserves the
  current behaviour.

---

## 6. Sub-Tasks to Create

Each row maps to a new kanban task in the `sys` board. Ordering
matches the dependency chain (read endpoints → write endpoints →
permissions → UI → tests → docs).

| # | Title | Priority | Depends on |
|---|-------|----------|------------|
| 1 | Backend: `GET /api/v1/auth/users/:id/agents` returning Agents owned by the given user | high | — |
| 2 | Backend: `GET /api/v1/auth/agents/:id` returning single-Agent detail incl. creator | high | — |
| 3 | Backend: `PATCH /api/v1/auth/agents/:id/owner` for ADMIN re-parenting + activity log entry | high | 1 |
| 4 | Backend: relax `ResetAgentToken` + `DeleteAgent` to allow creator non-admins | medium | — |
| 5 | Backend: extend `GetAgents` with `?owner=<username>` query filter | medium | 1 |
| 6 | Backend: include `agentCreatedBy` on `GET /api/v1/runs/:id` payload | low | — |
| 7 | Backend tests: add the 14-row table-driven suite in §5.1 | high | 1-4 |
| 8 | CLI: `kanban auth agent show <id>` + `--owner` filter on list | medium | 2, 5 |
| 9 | CLI tests: extend `agents.test.ts` with §5.3 cases | medium | 8 |
| 10 | Frontend: Agent-manager page "Created by" column + Orphaned badge + Re-parent modal | medium | 3 |
| 11 | Frontend: i18n strings for the new column / badge / modal | medium | 10 |
| 12 | Frontend tests: §5.4 component tests | medium | 10 |
| 13 | Migration smoke test: cover 008 upgrade / downgrade paths | high | — |
| 14 | Docs: update `docs/API_CHANGELOG.md`, `cli/README.md`, `cli/README_ZH.md` to document `createdBy` semantics + the new endpoints | low | 1-12 |
| 15 | CHANGELOG entry: feature "Agent creator identification" + new endpoints / flags | low | 1-14 |

---

## 7. Out of Scope

- Promoting Agents to a separate `agents` table with its own
  per-Agent rate-limit / quota columns. Re-evaluate after the
  permission and ownership flows stabilise.
- Per-Agent scope delegation: allowing an Agent to act on behalf of
  multiple humans through OAuth. The current `oauth_consents` row
  already keys on `(user_id, client_id)` so the design would extend
  cleanly, but it is out of scope for phase 1.
- Cross-instance ownership transfer (moving an Agent from server A
  to server B while preserving `created_by`). Today's single-instance
  design does not anticipate this.
- Bulk re-parent tool for legacy NULL-`created_by` Agents. The CLI
  will accept `kanban auth agent reparent --all-orphans` as a
  follow-up if operators want it.

---

## 8. Open Questions Resolved

| Question | Decision |
|----------|----------|
| Where do we store the creator? | `users.created_by` (FK to `users.id`), nullable. Migration 008. |
| Who can re-parent an Agent? | ADMIN only (phase 1). Creator-self re-parent is rejected with 422 to keep the audit trail simple. |
| What happens when the creator is deleted? | `ON DELETE SET NULL` — Agent stays alive, becomes "Orphaned". |
| Does `created_by` need a backfill for pre-008 AGENTs? | No — nullable by design. Re-parent via the new `PATCH` endpoint when an ADMIN identifies the right owner. |
| Can the creator see Agents they made in `/api/v1/auth/users/:id/agents`? | Yes — visibility rule allows self-query without ADMIN. |
| Does `tasks.created_by` change? | No — that's a separate column tracking the human who authored the **task**, not the Agent. The two coexist. |
| Is the CLI `--owner` filter server-side or client-side? | Server-side via `?owner=<username>` — the SQL filter is cheaper than materialising every Agent for every list call. |
| Does `agentCreatedBy` on `/runs/{id}` need a new JOIN? | No — the existing `users u ON r.agent_id = u.id` join in the run query is reused; we just add the LEFT JOIN on `created_by` to that query. |

---

## 9. References

- s-1131 — CLI auth login 身份选择与创建者识别 (shipped 2026-09-13). The
  present task is its data-model counterpart.
- s-1112 — 授权设备时需要选择授权身份. The device-flow Agent-selector
  uses `createdBy` to filter which Agents an approver can pick.
- `devDoc/DEVICE_AUTH_AGENT_SELECTION_PLAN_2026-09-13.md` — phase-1
  of the same feature, already shipped.
- `backend/internal/database/migrations/{sqlite,mysql}/008_agent_created_by.{up,down}.sql`
  — the schema migration that this design depends on.
- `backend/internal/handlers/auth_user_handlers.go:328-488` —
  `GetAgents` + `CreateAgent` (already stamp + return creator).
