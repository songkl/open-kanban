-- Reverse of 008_agent_created_by.up.sql: drop the index then drop the
-- column. SQLite's ALTER TABLE DROP COLUMN was added in 3.35; the
-- minimum version we target is 3.35 so we can rely on it.
--
-- Any Agent rows that pointed at a creator lose that reference when
-- the column is dropped — the Agent row itself stays alive because
-- the FK was ON DELETE SET NULL (deleting the creator already nulled
-- the column, so this is a no-op for those rows).

DROP INDEX IF EXISTS idx_users_created_by;

ALTER TABLE users DROP COLUMN created_by;