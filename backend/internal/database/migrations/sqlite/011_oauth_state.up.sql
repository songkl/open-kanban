-- pending_oauth_states: short-lived CSRF + PKCE state for the
-- external-IdP authorize dance (s-1145, plan §7.1 / §7.2 in
-- docs/OAUTH_EXTERNAL_PLAN_s-1139.md).
--
-- The /oauth/external/:slug/login handler mints one row per click
-- on "Sign in with Google" etc. The browser is redirected to the
-- IdP with `state=<this row's state column>` and
-- `code_challenge=<this row's code_challenge>`; the IdP bounces
-- back to /oauth/external/:slug/callback carrying the same `state`
-- value. The callback handler looks up the row by state, refuses
-- to proceed unless (a) the row exists, (b) it is not yet
-- consumed, (c) it is not expired, and (d) the PKCE verifier
-- matches the stored challenge. The row is then stamped
-- consumed_at so a replayed callback (an attacker who managed to
-- observe the IdP redirect) cannot log the user in a second time.
--
-- Column rationale:
--
--   * id            — internal ULID PK; never sent to the browser.
--                     The wire-level CSRF token is `state`, not id.
--   * state         — the wire-level CSRF token. 32 random bytes
--                     base64url-encoded (43 chars) per plan §7.1.
--                     UNIQUE so the callback's lookup is a single
--                     indexed point read.
--   * provider_id   — FK to oauth_providers.id with ON DELETE
--                     CASCADE. If an admin disables a provider
--                     while a login is mid-flight, the dangling
--                     state rows go away atomically.
--   * code_verifier — PKCE secret. 32 random bytes base64url-encoded
--                     (43 chars) per RFC 7636 §4.1. NEVER sent to
--                     the IdP — only its SHA-256 digest (the
--                     code_challenge) travels to the IdP, and the
--                     raw verifier only travels from the IdP back
--                     to our token exchange.
--   * code_challenge — base64url(SHA-256(code_verifier)) per RFC
--                     7636 §4.2. Sent on the authorize request as
--                     `code_challenge`; the IdP echoes it on the
--                     token request and our fetcher supplies the
--                     verifier so the IdP can re-hash and compare.
--                     Stored alongside the verifier so a future
--                     migration to plain (S256-less) PKCE is one
--                     column flip away.
--   * redirect_after — optional post-callback landing URL the SPA
--                     stashed in the query string. Empty when the
--                     SPA did not pass one. The handler only
--                     accepts relative paths starting with "/" to
--                     prevent an open-redirect that would let an
--                     attacker bounce the user to a phishing page.
--   * created_at    — stamped DEFAULT CURRENT_TIMESTAMP so the
--                     login handler doesn't have to remember to
--                     set it.
--   * expires_at    — 10 minutes after created_at per plan §7.1.
--                     The callback handler refuses to consume a
--                     row past this deadline, and the cleanup job
--                     (see "Housekeeping" below) sweeps expired
--                     rows on a schedule.
--   * consumed_at   — NULL until the callback succeeds. A
--                     non-NULL value makes the row a one-shot;
--                     replaying the same `state` value against
--                     the callback returns 400.
--
-- Indexes:
--
--   * UNIQUE(state) — backs the callback's hot-path lookup. The
--                     32-byte random value gives ~2^256 bits of
--                     collision resistance, but the UNIQUE
--                     constraint turns "no collision possible" into
--                     "DB enforces no row has two states".
--   * idx_pending_oauth_states_expires — backs the housekeeping
--                     sweep that deletes rows older than the TTL.
--                     Keeps the table small even on a deployment
--                     that sees heavy external-login traffic.
--   * idx_pending_oauth_states_provider — optional secondary
--                     index for ops who want to "kill every
--                     in-flight state for a provider" by
--                     provider_id (e.g. when a misconfigured IdP
--                     needs to be replaced mid-login).
--
-- Housekeeping: a periodic cleanup job (out of scope for s-1145)
-- deletes rows WHERE expires_at < now() to keep the table bounded.
-- The 10-minute TTL is short enough that a nightly job is overkill
-- but cheap; one row is at most ~250 bytes (state + verifier +
-- challenge + 3 timestamps + id + provider_id) so even 100k
-- abandoned clicks is under 25 MiB.
--
-- The (state, expires_at, consumed_at) triple is the CSRF
-- enforcement surface: state must match, must be unexpired, and
-- must not have been consumed. Any one of those failing → 400 +
-- audit row + clear cookie.

CREATE TABLE IF NOT EXISTS pending_oauth_states (
    id              TEXT PRIMARY KEY,
    state           TEXT NOT NULL UNIQUE,
    provider_id     TEXT NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
    code_verifier   TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    redirect_after  TEXT NOT NULL DEFAULT '',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME NOT NULL,
    consumed_at     DATETIME
);

CREATE INDEX IF NOT EXISTS idx_pending_oauth_states_expires ON pending_oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_oauth_states_provider ON pending_oauth_states(provider_id);
