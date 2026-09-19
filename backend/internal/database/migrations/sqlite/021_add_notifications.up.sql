-- In-app notification center (s-1194).
--
-- Rows here drive the persistent bell badge in the new top-bar UI
-- surface. They are NOT the same as the `activities` audit log
-- (which is admin-only and records every mutation); a row here is a
-- user-targeted, dismissable message.
--
-- Source-tagged rows map to the four streams the PM spec lists for
-- §5.2 ROI #2:
--
--   TASK_ASSIGNED     — assignee changed to me on a task
--   TASK_MENTIONED    — comment body contains @<myNickname>
--   RUN_COMPLETED     — an agent run I own hit a terminal status
--   WEBHOOK_FAILED    — outbound webhook delivery failed
--
-- Notification fan-out is performed in-process by the handlers
-- (see internal/handlers/notifications.go), and a WebSocket
-- broadcast is enqueued on insert so connected clients can refresh
-- their unread badge without polling.

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('TASK_ASSIGNED', 'TASK_MENTIONED', 'RUN_COMPLETED', 'WEBHOOK_FAILED')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    target_type TEXT NOT NULL DEFAULT '' CHECK(target_type IN ('', 'TASK', 'COMMENT', 'RUN', 'WEBHOOK')),
    target_id TEXT NOT NULL DEFAULT '',
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);