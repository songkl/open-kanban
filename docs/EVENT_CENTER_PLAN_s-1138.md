# Event Center — Multi-stage Webhook Configuration Design

**Task**: s-1138 — 规划：事件中心 - Webhook 多阶段配置
**Date**: 2026-09-13
**Status**: Design plan (awaiting sub-task creation)
**Depends on**: existing webhook service (`backend/internal/services/webhook_service.go`)

---

## 1. Hard Requirement

> Webhook delivery MUST be configurable per-event (and optionally
> per-board / per-column / per-priority filter), persisted in the
> database (not env vars), signed with HMAC-SHA256, retried with
> exponential back-off, rate-limited per destination, and inspectable
> through an admin UI — so that operators can wire Open-Kanban into
> arbitrary external systems without redeploying the server.

Why:

- **Portability.** The current `WEBHOOK_URL` env var forces a single
  global target and requires a restart to change. Operators want
  per-board or per-pipeline targets (e.g. "send all `task.moved`
  events from board `dev` to Slack, all `task.completed` events to
  the release bot").
- **Reliability.** A single failed POST (network blip, downstream
  restart) currently drops the event. Production automations need
  at-least-once delivery with bounded retries.
- **Security.** Today the only auth is a static `X-Webhook-Secret`
  header that the receiver must compare verbatim. Receivers expect
  HMAC-SHA256 over the raw body, with a per-webhook signing secret,
  delivered as `X-Webhook-Signature: sha256=<hex>` and a timestamp
  header to defeat replay.
- **Observability.** Operators need a delivery log (last N attempts
  per webhook + per event) and a one-click "send test event" to
  validate a new endpoint without waiting for a real event.

The hard requirement is implemented at the **schema layer** (new
`webhooks`, `webhook_deliveries`, `webhook_event_types` tables in
migration 009) and at the **service layer** (new
`EventCenter` goroutine pool that consumes from an in-memory queue
fanned out from existing call sites).

---

## 2. Current State (as of 2026-09-13)

### 2.1 Single global webhook

`backend/internal/services/webhook_service.go` exposes four event
types (`task.created`, `task.moved`, `task.completed`,
`task.commented`) and ships them to one URL pulled from the
`WEBHOOK_URL` env var. The signing surface is a static
`X-Webhook-Secret: <value>` header; there is no HMAC over the body.

The service is called inline from the request handlers:

| Event | Call site |
|---|---|
| `task.created` | `backend/internal/handlers/tasks_crud.go:67-69` |
| `task.moved` | `backend/internal/handlers/tasks_crud.go:183-185`, `backend/internal/handlers/tasks_special.go:159-168` |
| `task.completed` | `backend/internal/handlers/tasks_special.go:177` |
| `task.commented` | `backend/internal/handlers/comments.go:187-192` |

Each call is synchronous on the request goroutine — a slow webhook
target adds latency to the user-facing API call. There is no retry,
no DLQ, no per-webhook config, no UI.

### 2.2 Manual test endpoint

`POST /api/v1/webhooks/notify` (`backend/internal/handlers/webhook.go`)
lets an authenticated user trigger a single webhook event with a
synthetic payload. Useful for ops debugging but does not exercise
the new multi-webhook fan-out path.

### 2.3 Frontend has no webhook surface

`frontend/src/` contains no webhook settings, no delivery-log page,
no test-send dialog. Adding a settings tab is in scope.

---

## 3. Event Catalogue

The Event Center exposes a fixed, versioned catalogue. Each event
ships a JSON payload conforming to the schema below; new fields are
additive and receivers MUST ignore unknown keys.

| `event` | Trigger site | Payload root | Triggered when |
|---|---|---|---|
| `task.created` | `tasks_crud.go` `CreateTaskHandler` | `Task` | A new task row is inserted. |
| `task.updated` | `tasks_crud.go` `UpdateTaskHandler` | `Task` + `changes[]` | Title / description / priority / assignee / due date changes. |
| `task.moved` | `tasks_crud.go` `MoveTaskHandler`, `tasks_special.go` | `Task` + `fromColumnId`, `toColumnId` | A task crosses a column boundary. |
| `task.completed` | `tasks_special.go` `CompleteTaskHandler` | `Task` | A task is moved into a "done" column. |
| `task.deleted` | `tasks_crud.go` `DeleteTaskHandler` | `Task` (archived copy) | A task is removed (soft-delete). |
| `task.assigned` | `tasks_crud.go` `AssignTaskHandler` | `Task` + `previousAssignee` | Assignee changes (including `null → user`). |
| `task.commented` | `comments.go` `CreateCommentHandler` | `Task` + `Comment` | A comment row is inserted on a task. |
| `column.created` | `columns.go` `CreateColumnHandler` | `Column` | A new column is added to a board. |
| `column.updated` | `columns.go` `UpdateColumnHandler` | `Column` + `changes[]` | Column metadata changes. |
| `column.deleted` | `columns.go` `DeleteColumnHandler` | `Column` | A column is removed. |
| `board.created` | `boards_crud.go` `CreateBoardHandler` | `Board` | A new board is created. |
| `board.updated` | `boards_crud.go` `UpdateBoardHandler` | `Board` + `changes[]` | Board metadata changes. |

### 3.1 Envelope (every event)

```json
{
  "id":         "evt_01HZX...",       // ULID, unique per delivery attempt
  "type":       "task.moved",         // dot-namespaced event name
  "occurredAt": "2026-09-13T12:34:56Z",
  "deliveredAt":"2026-09-13T12:34:57Z",
  "actor": {
    "type": "USER",                   // USER | AGENT | SYSTEM
    "id":   "u_abc",
    "nickname": "alice"
  },
  "board":  { "id": "...", "name": "..." },  // omitted for board-level events
  "data":   { /* event-specific */ }
}
```

### 3.2 Common filters (per webhook)

- `boardIds []string` — only fire for these boards (empty = all)
- `columnIds []string` — only fire for these columns (empty = all)
- `priorities []string` — only fire for these priorities (empty = all)
- `assigneeIds []string` — only fire for these assignees (empty = all)

A row matches when **all** non-empty filter sets intersect the
event payload (logical AND across categories, OR within a category).

---

## 4. Webhook Configuration Model

```go
type Webhook struct {
    ID            string    // ULID
    Name          string    // operator-chosen label
    URL           string    // destination, validated at write time
    Secret        string    // HMAC-SHA256 signing key (generated, shown once)
    Enabled       bool
    EventTypes    []string  // event names from §3 catalogue
    Filters       Filters   // §3.2
    Headers       map[string]string // extra headers (auth tokens, etc.)
    TimeoutSec    int       // per-request timeout (default 10)
    MaxRetries    int       // default 5
    CreatedBy     string    // user id (audit)
    CreatedAt     time.Time
    UpdatedAt     time.Time
    LastSuccessAt *time.Time
    LastFailureAt *time.Time
}

type WebhookDelivery struct {
    ID           string    // ULID
    WebhookID    string
    EventID      string    // matches envelope.id
    EventType    string
    Status       string    // PENDING | SUCCESS | FAILED | EXHAUSTED
    Attempt      int       // 1-based
    RequestBody  string    // raw JSON sent
    ResponseCode int       // 0 if no response
    ResponseBody string    // first 4 KiB
    Error        string    // network / timeout message
    StartedAt    time.Time
    FinishedAt   *time.Time
    NextRetryAt  *time.Time
}
```

Storage: SQLite migration `009_webhook_center.up.sql` (and MySQL
twin). Tables live alongside existing migrations; indexes on
`(webhook_id, started_at DESC)` and `(status, next_retry_at)` so
the retry sweeper can find work cheaply.

---

## 5. Delivery Pipeline

```
HTTP handler  ──emit──▶  EventBus.Publish(event)
                              │
                              ▼
                     EventCenter dispatcher goroutine
                              │ (fan-out by event type)
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Webhook W1       Webhook W2       Webhook W3
              │               │               │
              ▼               ▼               ▼
        enqueue per-webhook delivery (status=PENDING)
              │
              ▼
   Worker pool (N=4 goroutines, configurable)
              │
              ▼
   Sign + POST  ──success──▶  SUCCESS row, no retry
                ──fail────▶  FAILED row + NextRetryAt = backoff(attempt)
                              │
                              ▼
   Retry sweeper (every 5 s) re-enqueues when due
                              │
                              ▼
   After MaxRetries  ──▶  EXHAUSTED row, alert via slog
```

### 5.1 Backoff

Exponential with jitter: `delay = min(60s, 2^attempt) + rand(0..1s)`.
Attempts are 1-based (`attempt=1` is the initial POST).

### 5.2 Signing

```
timestamp  = floor(unix_now)
to_sign    = timestamp + "." + raw_body
signature  = hex( HMAC_SHA256(secret, to_sign) )

Headers:
  X-Webhook-Id:        <webhook.id>
  X-Webhook-Event:     <event.type>
  X-Webhook-Delivery:  <delivery.id>
  X-Webhook-Timestamp: <timestamp>
  X-Webhook-Signature: sha256=<signature>
```

Receivers verify by recomputing HMAC and comparing with
`crypto/subtle.ConstantTimeCompare`, AND by rejecting events whose
timestamp is more than 5 minutes off (`replay window`).

### 5.3 Rate limiting

Per webhook: at most `RATE_LIMIT_PER_MIN` requests / 60 s, default
60. Excess deliveries are rescheduled (NextRetryAt += 1 s) rather
than dropped — they remain at-least-once, just delayed.

### 5.4 URL validation (write-time)

`webhooks.URL` MUST match:
- scheme `https://` (or `http://` only if explicitly opted-in via `WEBHOOK_ALLOW_INSECURE=1`)
- no localhost / 127.0.0.0/8 / 169.254.0.0/16 / RFC1918 ranges unless `WEBHOOK_ALLOW_PRIVATE=1`
- DNS resolves at write time (warning if not)

### 5.5 Timeout

Per-request `TimeoutSec` (default 10 s). Connections that exceed it
count as a failed attempt and retry.

---

## 6. Security

- All `/api/v1/webhooks/*` endpoints require `RequireAuth` with role
  `ADMIN` (config CRUD) or any authenticated user (read-only list +
  deliveries).
- `secret` is returned **once** at creation time (and on rotate).
  Subsequent `GET /webhooks/:id` returns `"********"` for the field.
- CSRF: webhooks are server-to-server; no browser flow, no CSRF
  needed.
- Audit log: writes append to existing `auth_activity` log
  (`auth_activity.go`) with `action = "webhook.created" |
  "webhook.updated" | "webhook.deleted" | "webhook.tested"`.

---

## 7. Management UI

Three frontend surfaces, all under `frontend/src/views/settings/`:

### 7.1 Webhooks list (`WebhooksList.vue`)

- Table: name, URL (truncated), enabled, event types (chips),
  last success / failure (relative time), 24h success rate.
- Row actions: edit, toggle enabled, test-send, view deliveries,
  delete.
- "New webhook" button → opens `WebhookFormDialog.vue`.

### 7.2 Form dialog (`WebhookFormDialog.vue`)

Fields:
- Name (required, 1–64 chars)
- URL (required, validated client-side with same rules as §5.4)
- Event types (multi-select from §3 catalogue; chips)
- Filters (collapsible: board / column / priority / assignee pickers)
- Headers (key/value editor, max 10)
- Timeout (5–60 s, default 10)
- Max retries (0–10, default 5)
- Secret (auto-generated button "Generate"; reveal-once input)

### 7.3 Delivery log (`WebhookDeliveries.vue`)

- Per webhook: paginated table of `WebhookDelivery` rows.
- Columns: event type, status, attempt, response code, duration,
  started at, error.
- Row click → modal with raw request / response body (first 4 KiB)
  for debugging.

### 7.4 Test send

A "Send test event" button on each row fires a synthetic event of
the chosen type through the full pipeline (signing, retries,
delivery log) and shows the first attempt result inline.

---

## 8. REST API

All routes mounted under `/api/v1/webhooks/`. JSON in / JSON out.
Public list endpoint is omitted; all routes are authenticated.

| Method | Path | Role | Description |
|---|---|---|---|
| GET    | `/api/v1/webhooks`              | any auth | List webhooks (no secret). |
| POST   | `/api/v1/webhooks`              | ADMIN    | Create webhook; response includes plaintext secret once. |
| GET    | `/api/v1/webhooks/:id`          | any auth | Fetch one (secret redacted). |
| PATCH  | `/api/v1/webhooks/:id`          | ADMIN    | Update mutable fields. |
| DELETE | `/api/v1/webhooks/:id`          | ADMIN    | Delete (also deletes deliveries). |
| POST   | `/api/v1/webhooks/:id/rotate`   | ADMIN    | Generate a new secret; returns plaintext once. |
| POST   | `/api/v1/webhooks/:id/test`     | any auth | Send a synthetic event of chosen type. |
| GET    | `/api/v1/webhooks/:id/deliveries?limit=&cursor=` | any auth | Paginated delivery log. |
| GET    | `/api/v1/webhooks/events`       | any auth | Catalogue from §3 (frontend picker source). |

`GET /api/v1/webhooks/events` is the single source of truth for the
catalogue; the frontend MUST render its picker from this endpoint
so adding a new event type is a backend-only change.

---

## 9. Implementation Task Breakdown

The work below is split into independently-shippable subtasks. Each
subtask ID is the next free `s-1139..s-1147` (to be assigned by the
kanban system on creation).

| # | Subtask ID | Title | Depends on | Backend / Frontend | Est. scope |
|---|---|---|---|---|---|
| 1 | s-1139 | migration 009 — webhooks + webhook_deliveries tables | — | backend | ~120 LoC, 2 test files |
| 2 | s-1140 | WebhookConfig CRUD service + repository layer | s-1139 | backend | ~250 LoC, 1 test file |
| 3 | s-1141 | EventBus + EventCenter dispatcher + worker pool | s-1140 | backend | ~200 LoC, 1 test file |
| 4 | s-1142 | HMAC-SHA256 signing + retry/backoff + rate limit | s-1141 | backend | ~180 LoC, 1 test file |
| 5 | s-1143 | REST handlers for /api/v1/webhooks/* (admin auth) | s-1140 | backend | ~300 LoC, 1 test file |
| 6 | s-1144 | wire event emission at existing call sites (tasks / columns / boards / comments) | s-1141 | backend | ~80 LoC, 1 test file |
| 7 | s-1145 | /api/v1/webhooks/events catalogue endpoint | s-1141 | backend | ~50 LoC, 1 test file |
| 8 | s-1146 | frontend WebhooksList + WebhookFormDialog + WebhookDeliveries pages | s-1143, s-1145 | frontend | ~600 LoC, vitest coverage |
| 9 | s-1147 | end-to-end test report + CHANGELOG entry | all above | docs + tests | ~80 LoC tests, 1 doc |

### 9.1 Subtask ordering

```
s-1139 (schema)
   └─▶ s-1140 (repo + service)
          ├─▶ s-1141 (event bus + dispatcher)
          │       ├─▶ s-1142 (signing + retry + rate limit)
          │       ├─▶ s-1144 (wire call sites)
          │       └─▶ s-1145 (catalogue endpoint)
          └─▶ s-1143 (REST handlers)
                  └─▶ s-1146 (frontend)
                         └─▶ s-1147 (e2e report + CHANGELOG)
```

Critical path: **s-1139 → s-1140 → s-1141 → s-1143 → s-1146 → s-1147**.
Tasks s-1142, s-1144, s-1145 can run in parallel after s-1141.

### 9.2 Test strategy

- **Backend**: every subtask ships `*_test.go` with table-driven
  cases. s-1139 covers schema + indexes (in-memory SQLite). s-1140
  covers CRUD + secret redaction. s-1141 covers fan-out / no-op when
  no webhooks match. s-1142 covers signing verification vectors,
  backoff math, rate limit rescheduling, and timeout behaviour
  using `httptest.Server`.
- **End-to-end**: s-1147 stands up `httptest.Server`, registers a
  webhook, emits events from the existing call sites, asserts
  delivery rows land in `SUCCESS` and a forced 500 response drives
  the retry path to `EXHAUSTED` after `MaxRetries`.
- **Frontend**: vitest + @vue/test-utils for the form dialog
  (validation, secret-reveal-once behaviour) and the deliveries
  table (pagination, status badge mapping).

### 9.3 Backwards compatibility

The existing `WEBHOOK_ENABLED` / `WEBHOOK_URL` / `WEBHOOK_SECRET`
env vars remain honoured as a **fallback single-row seed** during
the first boot after upgrade: if `webhooks` table is empty and the
env vars are set, s-1140 inserts a single row equivalent to the
current behaviour. Operators can edit it through the UI afterwards.
The legacy `webhook_service.go` globals are removed in s-1143 once
all call sites route through `EventBus`.

---

## 10. Open Questions (to resolve before s-1141 starts)

1. **Persistent outbox vs in-memory queue.** For at-least-once
   across restarts the event bus needs to durably enqueue (SQLite
   outbox table or BoltDB). Trade-off: schema complexity vs
   durability. Proposal: add `event_outbox` table in migration 009,
   drain on boot. **Decision needed**.
2. **Per-board vs global webhook scope.** Should a webhook be
   board-scoped (lives under a board, inherits its ACL) or
   global (admin-only)? Proposal: **global**, with `boardIds`
   filter — keeps the model uniform and avoids ACL multiplication.
3. **Self-signed TLS.** Production targets may use self-signed certs.
   Proposal: trust-store honoured; no `InsecureSkipVerify` knob.
   **Confirm before s-1142**.
