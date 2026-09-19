-- Reverse of 016_add_frontend_events.up.sql. The FK
-- constraint is dropped with the table; explicit DROP INDEX
-- first matches the up migration's order and keeps the
-- down migration symmetrical.

DROP INDEX IF EXISTS idx_frontend_events_event_type;
DROP INDEX IF EXISTS idx_frontend_events_received_at;
DROP INDEX IF EXISTS idx_frontend_events_user_id;
DROP TABLE IF EXISTS frontend_events;