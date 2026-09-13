-- Reverse of 010_user_identities.up.sql. Drops the new
-- user_identities table + its indexes, then drops the email
-- column from users. We do this in the reverse order so that
-- if anything fails partway through the rollback, the most-
-- recently-dropped object is the easy one to re-create (a
-- lone users.email column with no bindings is harmless; a
-- lone user_identities table with no email column is broken).
--
-- user_identities rows drop with the table; the FK from
-- user_identities.user_id to users.id is removed by dropping
-- the table, so the subsequent ALTER TABLE on users.email
-- has no FK to undo.
--
-- Lossy: any external IdP bindings recorded by the system go
-- away along with the users.email column. Operators who care
-- about preserving this state across a downgrade must dump
-- both before running `migrate down`.

DROP INDEX IF EXISTS idx_user_identities_user;
DROP TABLE IF EXISTS user_identities;

DROP INDEX IF EXISTS idx_users_email;
ALTER TABLE users DROP COLUMN email;
