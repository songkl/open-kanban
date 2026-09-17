-- Reverse of 013_add_viewer_tokens.up.sql. Drops the indexes
-- first (SQLite is fine without it, but keeping the order matches
-- the MySQL side and keeps the down migration symmetrical with the
-- up migration).

DROP INDEX IF EXISTS idx_viewer_tokens_token_hash;
DROP INDEX IF EXISTS idx_viewer_tokens_board_id;
DROP TABLE IF EXISTS viewer_tokens;