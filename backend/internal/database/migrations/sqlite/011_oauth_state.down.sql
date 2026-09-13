-- Reverse of 011_oauth_state.up.sql. Drops the indexes first
-- (so the FK on provider_id isn't pinned by idx_pending_oauth_states_provider),
-- then the table. The oauth_providers table itself is left alone —
-- rolling back the state table does not affect provider CRUD.
--
-- Lossy: every in-flight external-IdP login is invalidated by the
-- rollback. Users mid-click on "Sign in with Google" will see
-- their callback 400 out, but the only durable state on the user
-- side is the session cookie (still valid until its own TTL);
-- no account-level data is lost.

DROP INDEX IF EXISTS idx_pending_oauth_states_expires;
DROP INDEX IF EXISTS idx_pending_oauth_states_provider;
DROP TABLE IF EXISTS pending_oauth_states;
