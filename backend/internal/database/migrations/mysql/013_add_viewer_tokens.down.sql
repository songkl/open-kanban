-- Reverse of 013_add_viewer_tokens.up.sql. The FK constraints are
-- dropped with the table; explicit DROP FK first is required on
-- MySQL when other tables may reference the columns.

DROP TABLE IF EXISTS viewer_tokens;