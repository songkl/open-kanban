-- Widen comments.content from TEXT (max 65,535 bytes) to LONGTEXT
-- (max 4 GiB) so the API can accept comment bodies of arbitrary
-- length. The application handler already removed its prior
-- `max=2000` validator tag (see s-1025, commit b9d39ac) and there is
-- no other application-level length check, so before this change any
-- content beyond ~64 KiB on MySQL would fail at the storage layer
-- with a 500 from the driver. Widening to LONGTEXT removes that
-- silent ceiling and matches the storage model already used by
-- SQLite (TEXT, which is variable-length up to ~1 GiB).
--
-- MODIFY COLUMN is a metadata-only change in MySQL 8.0+ for a type
-- widening (no row rewrite), so this is safe to apply online on
-- large tables. The companion .down.sql restores the original TEXT
-- type and is therefore destructive for any rows whose content
-- exceeds the TEXT cap; the downgrade must only be run after a
-- manual cleanup if such rows exist.

ALTER TABLE comments
    MODIFY COLUMN content LONGTEXT NOT NULL;