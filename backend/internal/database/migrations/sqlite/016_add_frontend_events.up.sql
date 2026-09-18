-- Frontend error reporting sink (s-1210, PM_REVIEW_2026-09-17 §7).
--
-- The PM review surfaced six 404s in the screenshots that the
-- frontend had swallowed silently — there was no global error
-- boundary, no window.onerror hook, and no unhandledrejection
-- listener, so any uncaught React render error or stray promise
-- rejection just disappeared. This table backs the new
-- Sentry-compatible ingest endpoint at
-- POST /api/v1/frontend-events, which captures:
--
--   - React component errors (caught by the root ErrorBoundary
--     and re-thrown into the global handler).
--   - window.onerror events (script errors, network race
--     conditions, etc.).
--   - unhandledrejection events (async failures that never had
--     a .catch() attached).
--
-- The frontend scrubs Authorization / Cookie / Bearer tokens
-- before posting, and the handler applies a second-pass
-- redaction so a future client regression cannot leak a
-- credential into the database.
--
-- Columns:
--   id          — TEXT PK, generated server-side. Surfaced back
--              to the caller as `{ "id": "…" }` so a future
--              ingest dashboard can de-duplicate across page
--              refreshes.
--   user_id     — FK users.id ON DELETE SET NULL. Nullable on
--              purpose: an unhandled exception during the
--              pre-login setup flow has no associated user.
--              SET NULL (not CASCADE) so deleting a user does
--              not wipe the historical error trail.
--   event_type  — TEXT NOT NULL. One of "error",
--              "unhandled_rejection", "react_error". Stored
--              as a free string rather than a CHECK list so the
--              frontend can introduce new event types without
--              a server-side migration; the redaction logic in
--              handlers/frontend_events.go validates the value
--              before INSERT.
--   message     — TEXT. The error.message / reason string. The
--              handler enforces a 4KB cap so a chatty stack
--              or a chatty postMessage cannot fill the row.
--   stack       — TEXT. The serialized Error.stack, capped at
--              32KB. Trailing frames after that point are
--              truncated server-side so the column is bounded.
--   url         — TEXT. window.location.href captured at the
--              throw site. Capped at 2KB.
--   source      — TEXT. Best-effort filename:lineno:colno
--              string (the columns event.filename +
--              event.lineno + event.colno triple joined into
--              a single human-readable label). "" when the
--              browser did not provide a value.
--   details     — TEXT. JSON-encoded bag of extra context the
--              client chose to attach — typically
--              {componentStack, environment, breadcrumbs}. The
--              handler caps this at 8KB and runs the same
--              secret-redaction pass that runs on `message` so
--              embedded tokens never reach the row.
--   received_at — DATETIME DEFAULT CURRENT_TIMESTAMP. The
--              backend clock, NOT the client-reported time, so a
--              misconfigured client cannot fabricate the audit
--              trail.

CREATE TABLE IF NOT EXISTS frontend_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT,
    stack TEXT,
    url TEXT,
    source TEXT,
    details TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_frontend_events_user_id ON frontend_events(user_id);
CREATE INDEX IF NOT EXISTS idx_frontend_events_received_at ON frontend_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_frontend_events_event_type ON frontend_events(event_type);