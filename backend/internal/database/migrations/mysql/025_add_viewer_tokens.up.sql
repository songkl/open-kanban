-- Public read-only viewer tokens (s-1204, PM_REVIEW_2026-09-17 §6).
--
-- MySQL side mirrors the SQLite side in
-- 013_add_viewer_tokens.up.sql. VARCHAR(64) for id matches the
-- convention used elsewhere (boards.id, users.id). `token_hash` is
-- CHAR(64) because SHA-256 hex is always exactly 64 chars, and a
-- fixed-length column makes the UNIQUE index cheap.

CREATE TABLE IF NOT EXISTS viewer_tokens (
    id VARCHAR(64) NOT NULL,
    board_id VARCHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    label TEXT NOT NULL,
    created_by VARCHAR(64),
    expires_at DATETIME,
    revoked_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_viewer_tokens_token_hash (token_hash),
    KEY idx_viewer_tokens_board_id (board_id),
    CONSTRAINT fk_viewer_tokens_board FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
    CONSTRAINT fk_viewer_tokens_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;