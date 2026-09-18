-- Reverse of 016_add_frontend_events.up.sql. The FK
-- constraint is dropped with the table; explicit DROP FK
-- first is required on MySQL when other tables may reference
-- the columns.

DROP TABLE IF EXISTS frontend_events;