-- Rollback consolidated schema v1.0.0
-- Drops all tables created by the consolidated initial schema

DROP TABLE IF EXISTS templates;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS subtasks;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS column_agents;
DROP TABLE IF EXISTS columns;
DROP TABLE IF EXISTS board_permissions;
DROP TABLE IF EXISTS boards;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS users;
