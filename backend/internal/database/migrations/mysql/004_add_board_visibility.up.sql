-- Add the is_public visibility flag to the boards table so the
-- /api/boards list endpoint can filter out private boards for
-- anonymous and unauthorized users.
--
-- Default 1 keeps existing rows public, preserving the current
-- "anyone can see all boards" behaviour on upgrade. New boards
-- inherit the same default so the feature is opt-in for board
-- owners who explicitly uncheck the visibility toggle.

ALTER TABLE boards ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1;
