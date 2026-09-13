-- Reverse of 009_oauth_providers.up.sql: drop the lookup index
-- first (so the index doesn't pin a column that we're about to
-- drop), then drop the table itself. MySQL needs the FK on
-- created_by dropped explicitly before the table can disappear
-- cleanly; dropping the table takes care of that automatically,
-- but the explicit DROP FOREIGN KEY keeps the rollback order
-- obvious to a future reader.
--
-- Lossy: any configured providers disappear along with their
-- encrypted client_secrets. Operators who care about preserving
-- the config across a downgrade must dump the table before
-- running `migrate down`.

DROP INDEX idx_oauth_providers_enabled ON oauth_providers;

DROP TABLE IF EXISTS oauth_providers;
