-- Reverse of 008_agent_created_by.up.sql: drop the FK + index, then
-- drop the column. MySQL needs the FK dropped before the column can
-- be removed (FK constraints reference the column).
--
-- Lossy in the same sense as the SQLite .down.sql: any Agent row
-- whose creator was deleted already has created_by = NULL, so this is
-- a no-op for those rows.

ALTER TABLE users DROP FOREIGN KEY fk_users_created_by;
DROP INDEX idx_users_created_by ON users;
ALTER TABLE users DROP COLUMN created_by;