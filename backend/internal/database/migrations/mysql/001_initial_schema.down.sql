-- Destructive reset: drops every table created by 001_initial_schema.
-- Used by the `migrate down` subcommand for operators who want to start
-- from a clean slate. Order matters — drop child tables (those with
-- FOREIGN KEY) before the parents they reference.

DROP TABLE IF EXISTS oauth_consents;
DROP TABLE IF EXISTS oauth_refresh_tokens;
DROP TABLE IF EXISTS oauth_device_codes;
DROP TABLE IF EXISTS oauth_authorization_codes;
DROP TABLE IF EXISTS oauth_clients;

DROP TABLE IF EXISTS templates;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS subtasks;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS column_agents;
DROP TABLE IF EXISTS `columns`;
DROP TABLE IF EXISTS column_permissions;
DROP TABLE IF EXISTS board_permissions;
DROP TABLE IF EXISTS boards;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS users;

DROP TABLE IF EXISTS app_config;
