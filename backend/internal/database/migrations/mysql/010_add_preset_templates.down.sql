-- Reverse of 010_add_preset_templates.up.sql for MySQL.

DROP INDEX idx_preset_templates_position ON preset_templates;
DROP TABLE IF EXISTS preset_templates;