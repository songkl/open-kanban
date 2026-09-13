-- Reverse of 011_oauth_state.up.sql. Drops the indexes first so
-- the FK on provider_id isn't pinned by the secondary index,
-- then the table itself.
--
-- Lossy: every in-flight external-IdP login is invalidated by the
-- rollback. Users mid-click on "Sign in with Google" will see
-- their callback 400 out; the only durable state on the user side
-- is the session cookie, which is still valid until its own TTL.

DROP INDEX idx_pending_oauth_states_expires ON pending_oauth_states;
DROP INDEX idx_pending_oauth_states_provider ON pending_oauth_states;
DROP TABLE IF EXISTS pending_oauth_states;
