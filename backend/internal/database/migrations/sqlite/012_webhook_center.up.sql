-- webhooks + webhook_deliveries: outbound webhook configuration and
-- delivery log (s-1139, plan §4 in
-- docs/EVENT_CENTER_PLAN_s-1138.md).
--
-- Originally drafted as migration 009 in plan §4, but the OAuth
-- external-IdP work (s-1140 / s-1142 / s-1145) landed first and
-- claimed 009_oauth_providers / 010_user_identities /
-- 011_oauth_state. This migration therefore ships as 012 to keep
-- the golang-migrate alphabetical sequence monotonic.
--
-- Two tables:
--
--   * webhooks          — one row per outbound webhook the operator
--                         has configured. Names a URL, a per-webhook
--                         HMAC signing secret, the event catalogue
--                         subset the operator cares about, optional
--                         per-event filters, optional extra headers,
--                         and per-request timeout / retry budget.
--
--   * webhook_deliveries — append-only log of every attempt to
--                          deliver an event to a webhook. The
--                          worker pool (s-1141) INSERTs a row with
--                          status='PENDING' at enqueue time and
--                          UPDATEs it as the dispatch progresses;
--                          the retry sweeper (s-1142) reads
--                          status + next_retry_at to pick the next
--                          batch. Retaining terminal rows (status
--                          in {SUCCESS, FAILED, EXHAUSTED}) gives
--                          the management UI a delivery history
--                          without a separate audit table.
--
-- Column rationale:
--
--   webhooks.id             — internal ULID PK. Surfaced in the
--                             X-Webhook-Id header per §5.2 so the
--                             receiver can dedupe across
--                             reconnects.
--   webhooks.name           — operator-chosen 1–64 char label, NOT
--                             UNIQUE so two webhooks may share a
--                             display name (e.g. two staging
--                             environments).
--   webhooks.url            — destination URL. Validated at write
--                             time per §5.4 (https-only unless
--                             WEBHOOK_ALLOW_INSECURE=1, no
--                             loopback / RFC1918 unless
--                             WEBHOOK_ALLOW_PRIVATE=1). Stored as
--                             TEXT NOT NULL.
--   webhooks.secret         — the HMAC-SHA256 signing key per §5.2.
--                             Stored as a BLOB so the plaintext
--                             doesn't show up in naive
--                             `SELECT *` dumps. Returned to the
--                             caller exactly once on create / rotate
--                             (§6); subsequent GETs return a
--                             redacted "********".
--   webhooks.enabled        — soft kill-switch. enabled=0 makes the
--                             dispatcher skip the row entirely so a
--                             misbehaving receiver can be silenced
--                             without losing the configuration.
--   webhooks.event_types    — JSON array of strings from §3
--                             catalogue, e.g.
--                             `["task.created","task.moved"]`.
--                             Validated at the API layer; the column
--                             itself is opaque JSON text so a future
--                             catalogue addition doesn't require a
--                             schema change.
--   webhooks.filters        — JSON object matching the §3.2 filter
--                             shape (boardIds / columnIds /
--                             priorities / assigneeIds). Empty
--                             object `{}` means "all events of the
--                             listed types, no narrowing". Same
--                             opaque-JSON contract as event_types.
--   webhooks.headers        — JSON object of extra request headers
--                             (auth tokens, API keys). Each value
--                             is sent verbatim on every attempt.
--                             Capped at 10 entries + 4 KiB total
--                             at the API layer per §7.2.
--   webhooks.timeout_sec    — per-request timeout, default 10
--                             seconds. Bounds the time a single
--                             attempt can block a worker
--                             goroutine.
--   webhooks.max_retries    — maximum number of retries after the
--                             initial attempt, default 5. After
--                             this many failures the delivery row
--                             transitions to status='EXHAUSTED'
--                             and stops being picked up by the
--                             retry sweeper.
--   webhooks.created_by     — users.id of the operator who created
--                             the webhook. Nullable so the
--                             back-fill path in §9.3 (seed from
--                             WEBHOOK_URL / WEBHOOK_SECRET env
--                             vars on first boot) can insert a row
--                             without a creator. ON DELETE SET
--                             NULL: deleting the admin must not
--                             silently re-parent or drop every
--                             webhook they configured.
--   webhooks.created_at /
--   webhooks.updated_at     — straight DATETIME stamps; the
--                             auth_activity audit log (§6) carries
--                             the per-change actor so we don't
--                             need updated_by here.
--   webhooks.last_success_at / last_failure_at — nullable timestamps
--                             the dispatcher updates after each
--                             terminal attempt. Powers the
--                             "Last success / Last failure" column
--                             in WebhooksList.vue (§7.1) and the
--                             "24h success rate" indicator. NULL
--                             for a freshly-created webhook.
--
--   webhook_deliveries.id          — internal ULID PK. Surfaced in
--                                    the X-Webhook-Delivery header
--                                    per §5.2 for receiver-side
--                                    dedupe.
--   webhook_deliveries.webhook_id  — FK to webhooks.id with ON
--                                    DELETE CASCADE. Deleting a
--                                    webhook (admin UI or rotate
--                                    flow when the operator wants
--                                    a clean re-create) sweeps
--                                    every historical delivery row
--                                    atomically so we never have
--                                    a delivery pointing at a
--                                    vanished webhook.
--   webhook_deliveries.event_id    — the envelope.id from §3 so
--                                    receivers can correlate a
--                                    delivery with the logical
--                                    event that triggered it.
--                                    Plain TEXT — the envelope
--                                    schema lives in the Go
--                                    event_bus layer, not the
--                                    DB.
--   webhook_deliveries.event_type  — denormalised event type from
--                                    §3 catalogue (e.g.
--                                    'task.created') so the
--                                    deliveries page can filter /
--                                    group without joining back
--                                    through an outbox table
--                                    that doesn't exist (the
--                                    in-memory event bus in
--                                    s-1141 keeps no outbox
--                                    row).
--   webhook_deliveries.status      — one of PENDING | SUCCESS |
--                                    FAILED | EXHAUSTED per plan
--                                    §4. CHECK constrained so a
--                                    buggy dispatcher can't
--                                    silently write 'pending' vs
--                                    'PENDING'.
--   webhook_deliveries.attempt     — 1-based attempt counter per
--                                    §5.1; attempt=1 is the
--                                    initial POST, attempt=2..N
--                                    are retries driven by the
--                                    retry sweeper.
--   webhook_deliveries.request_body — raw JSON body sent on this
--                                    attempt. Stored as TEXT;
--                                    capped to ~64 KiB at the API
--                                    layer (well above the §4
--                                    4 KiB response budget, so a
--                                    giant outgoing event can
--                                    still be reviewed).
--   webhook_deliveries.response_code — HTTP status code returned
--                                      by the receiver, or 0 if
--                                      the request never reached
--                                      the receiver (DNS failure,
--                                      TLS error, timeout).
--   webhook_deliveries.response_body — first 4 KiB of the response
--                                      body per §4. Capped at the
--                                      API layer so a chatty
--                                      receiver can't fill the
--                                      DB.
--   webhook_deliveries.error       — non-empty for network /
--                                      timeout / TLS failures
--                                      (i.e. response_code = 0);
--                                      NULL when the receiver
--                                      returned any HTTP status.
--   webhook_deliveries.started_at  — when the attempt started.
--                                    Backs the
--                                    idx_webhook_deliveries_webhook_started
--                                    index below.
--   webhook_deliveries.finished_at — when the attempt returned
--                                    (response received or
--                                    errored). NULL while status
--                                    = 'PENDING'.
--   webhook_deliveries.next_retry_at — when the retry sweeper
--                                      should re-enqueue this
--                                      delivery. NULL when
--                                      status in {SUCCESS,
--                                      PENDING}; set to
--                                      backoff(attempt) when
--                                      status = 'FAILED'. The
--                                      sweeper WHERE clause is
--                                      (status='FAILED' AND
--                                      next_retry_at <= now())
--                                      so the column needs to be
--                                      indexed together with
--                                      status (see below).
--
-- Indexes:
--
--   * idx_webhook_deliveries_webhook_started — backs the per-webhook
--     deliveries page query (§7.3, GET
--     /api/v1/webhooks/:id/deliveries) which sorts newest-first
--     and paginates by (webhook_id, started_at DESC). The
--     descending keyword on a CREATE INDEX is accepted but
--     ignored by SQLite (it scans the index backwards), so we
--     rely on SQLite's natural ability to do that without an
--     extra index.
--
--   * idx_webhook_deliveries_status_next_retry — backs the retry
--     sweeper's hot path: every 5 s it runs `SELECT ... WHERE
--     status = 'FAILED' AND next_retry_at <= ?`. Putting status
--     first makes the predicate selective enough on its own
--     that the next_retry_at part only matters once status has
--     narrowed the candidate set; that ordering is the one the
--     query planner actually uses.
--
-- The down migration drops the indexes first (so the FK on
-- webhook_deliveries.webhook_id isn't pinned by the secondary
-- index) and then the tables in dependency order
-- (webhook_deliveries before webhooks).
--
-- Lossy: every historical delivery is lost on rollback. That's
-- acceptable because the deliveries page is a debugging
-- surface — the canonical event history is the in-memory event
-- bus (s-1141) plus the existing activities table for any
-- event that wants a permanent audit trail.

CREATE TABLE IF NOT EXISTS webhooks (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    url                 TEXT NOT NULL,
    secret              BLOB NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    event_types         TEXT NOT NULL DEFAULT '[]',
    filters             TEXT NOT NULL DEFAULT '{}',
    headers             TEXT NOT NULL DEFAULT '{}',
    timeout_sec         INTEGER NOT NULL DEFAULT 10,
    max_retries         INTEGER NOT NULL DEFAULT 5,
    created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_success_at     DATETIME,
    last_failure_at     DATETIME
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT PRIMARY KEY,
    webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    status          TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED')),
    attempt         INTEGER NOT NULL DEFAULT 1,
    request_body    TEXT NOT NULL DEFAULT '',
    response_code   INTEGER NOT NULL DEFAULT 0,
    response_body   TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME,
    next_retry_at   DATETIME
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_started
    ON webhook_deliveries(webhook_id, started_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next_retry
    ON webhook_deliveries(status, next_retry_at);
