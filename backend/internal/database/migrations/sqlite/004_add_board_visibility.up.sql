-- Add the is_public visibility flag to the boards table so the
-- /api/boards list endpoint can filter out private boards for
-- anonymous and unauthorized users.
--
-- Default 1 keeps existing rows public, preserving the current
-- "anyone can see all boards" behaviour on upgrade. New boards
-- inherit the same default so the feature is opt-in for board
-- owners who explicitly uncheck the visibility toggle.
--
-- SQLite does not support `ALTER TABLE ... ADD COLUMN ... NOT
-- NULL DEFAULT ...` with a literal 1 directly — wrapping the
-- literal in parentheses is the documented workaround so SQLite
-- parses it as a typed constant rather than a missing-KW error.

ALTER TABLE boards ADD COLUMN is_public BOOLEAN DEFAULT (1);
