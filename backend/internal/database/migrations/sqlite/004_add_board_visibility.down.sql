-- Reverse of 004_add_board_visibility.up.sql: drop the is_public
-- column. SQLite supports DROP COLUMN as of 3.35+, which is the
-- floor the rest of the schema already assumes (see 001).
--
-- No data preservation — running down then back up restores the
-- default-public behaviour for all rows, which matches the up
-- migration's intended post-state.

ALTER TABLE boards DROP COLUMN is_public;
