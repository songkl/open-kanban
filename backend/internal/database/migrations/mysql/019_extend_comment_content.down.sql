-- Companion down migration for 007_extend_comment_content.
-- Restores comments.content from LONGTEXT back to TEXT (max 65,535
-- bytes). MySQL will reject this if any existing row exceeds the
-- TEXT cap, which is the desired behaviour: an operator who wants
-- the narrower type must first clean up oversized rows. Do NOT run
-- this on a production database without first verifying that all
-- comments fit in 65,535 bytes.

ALTER TABLE comments
    MODIFY COLUMN content TEXT NOT NULL;