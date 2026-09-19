-- Public read-only viewer tokens (s-1204, PM_REVIEW_2026-09-17 §6).
--
-- The PM review flagged that there is currently no way for a board
-- owner to publish a read-only snapshot of a board to a stakeholder
-- who does not (and should not) hold an account. The backend auth
-- layer is extended with a `VIEWER_PUBLIC_TOKEN` that gates a
-- sanitized board read endpoint, so the share surface stays out of
-- the regular /api/v1/boards access path and never escalates into a
-- session.
--
-- Columns:
--   id              — TEXT PK. Stable opaque id surfaced via the API
--                     so the owner can revoke a specific token by
--                     id without leaking the secret value.
--   board_id        — FK boards.id, ON DELETE CASCADE so removing a
--                     board also drops every token minted against
--                     it (we never want orphan tokens resolving to
--                     a missing board).
--   token_hash      — TEXT UNIQUE NOT NULL. SHA-256 hex of the
--                     secret value the owner pastes into the URL.
--                     We store the hash, never the plaintext — the
--                     plaintext is only returned ONCE at mint time,
--                     the same way the regular /api/v1/auth/token
--                     endpoint behaves.
--   label           — TEXT NOT NULL DEFAULT ''. Human-readable hint
--                     ("Stakeholder demo", "Marketing embed") so
--                     the owner can recognise a token in Settings
--                     without staring at the id.
--   created_by      — FK users.id ON DELETE SET NULL. Best-effort
--                     provenance for the audit trail; nullable +
--                     SET NULL so deleting a user does not cascade
--                     and wipe their tokens (the board keeps being
--                     shareable).
--   expires_at      — DATETIME NULLABLE. NULL means "never expires".
--                     The public lookup treats expired rows the
--                     same as revoked ones — 404 with no leak of
--                     whether the token ever existed.
--   revoked_at      — DATETIME NULLABLE. Soft-delete so the audit
--                     trail survives a revoke. Public lookup
--                     short-circuits on revoked_at IS NOT NULL.
--   created_at      — DATETIME, default now. Audit / sort field.

CREATE TABLE IF NOT EXISTS viewer_tokens (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    expires_at DATETIME,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_viewer_tokens_board_id ON viewer_tokens(board_id);
CREATE INDEX IF NOT EXISTS idx_viewer_tokens_token_hash ON viewer_tokens(token_hash);