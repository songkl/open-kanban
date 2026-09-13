-- Reverse of 009_oauth_providers.up.sql: drop the lookup index
-- first (so the index doesn't pin a column that we're about to
-- drop), then drop the table itself.
--
-- Lossy: any configured providers disappear along with their
-- encrypted client_secrets. Operators who care about preserving the
-- config across a downgrade must dump the table before running
-- `migrate down`.

DROP INDEX IF EXISTS idx_oauth_providers_enabled;

DROP TABLE IF EXISTS oauth_providers;
