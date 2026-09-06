-- Reverse of 004_add_board_visibility.up.sql: drop the is_public
-- column. No data preservation — running down then back up
-- restores the default-public behaviour for all rows, which
-- matches the up migration's intended post-state.

ALTER TABLE boards DROP COLUMN is_public;
