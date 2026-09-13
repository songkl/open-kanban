-- Reverse of 010_user_identities.up.sql. Drops the lookup
-- index first (so the FK on user_identities.provider_id is
-- the only thing pinning the column), then the table, then
-- the email column from users. MySQL needs the two FKs on
-- user_identities (to users.id and oauth_providers.id)
-- dropped explicitly before the table disappears cleanly;
-- dropping the table takes care of that automatically, but
-- the explicit DROP FOREIGN KEY keeps the rollback order
-- obvious to a future reader.
--
-- Lossy: any external IdP bindings go away along with
-- users.email. Operators who care about preserving this
-- state across a downgrade must dump both before running
-- `migrate down`.

ALTER TABLE users DROP INDEX idx_users_email;
ALTER TABLE users DROP COLUMN email;

DROP INDEX idx_user_identities_user ON user_identities;
DROP TABLE IF EXISTS user_identities;
