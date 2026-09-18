-- Frontend error reporting sink (s-1210, PM_REVIEW_2026-09-17 §7).
--
-- MySQL side mirrors the SQLite side in
-- 016_add_frontend_events.up.sql. VARCHAR(64) for id matches
-- the convention used elsewhere (boards.id, users.id, tokens.id).
-- `message` / `stack` / `details` / `url` / `source` are TEXT
-- rather than VARCHAR so the handler's runtime caps (4KB / 32KB /
-- 8KB / 2KB / 1KB respectively) can be enforced at the API
-- boundary without worrying about character-set padding.

CREATE TABLE IF NOT EXISTS frontend_events (
    id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64),
    event_type VARCHAR(64) NOT NULL,
    message TEXT,
    stack TEXT,
    url TEXT,
    source TEXT,
    details TEXT,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_frontend_events_user_id (user_id),
    KEY idx_frontend_events_received_at (received_at),
    KEY idx_frontend_events_event_type (event_type),
    CONSTRAINT fk_frontend_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;