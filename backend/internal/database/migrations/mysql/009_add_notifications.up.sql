-- In-app notification center (s-1194). See the matching SQLite
-- migration for the full design note; this MySQL variant uses the
-- VARCHAR(64) / TEXT sizing that the project's MySQL conventions
-- already use for IDs and free-form strings.

CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    source VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    target_type VARCHAR(16) NOT NULL DEFAULT '',
    target_id VARCHAR(64) NOT NULL DEFAULT '',
    read_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_notifications_source CHECK (source IN
        ('TASK_ASSIGNED', 'TASK_MENTIONED', 'RUN_COMPLETED', 'WEBHOOK_FAILED')),
    CONSTRAINT chk_notifications_target_type CHECK (target_type IN
        ('', 'TASK', 'COMMENT', 'RUN', 'WEBHOOK'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notifications_user_unread
    ON notifications(user_id, read_at);
CREATE INDEX idx_notifications_user_created
    ON notifications(user_id, created_at);