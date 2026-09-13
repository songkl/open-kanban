-- Track the human account that created each AGENT user.
--
-- See sqlite/008_agent_created_by.up.sql for the full rationale.
-- MySQL needs the explicit ON DELETE SET NULL clause on the FK (the
-- SQLite mirror) and a separate CREATE INDEX call afterwards. The
-- column type is VARCHAR(255) to match the rest of the users table;
-- nullable so the migration is a no-op against pre-existing rows.

ALTER TABLE users
    ADD COLUMN created_by VARCHAR(255) NULL,
    ADD CONSTRAINT fk_users_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_users_created_by ON users(created_by);