-- Reverse of 010_add_preset_templates.up.sql.
--
-- preset_templates is purely additive (no FK references it), so the
-- down migration just drops the index and table. The seeded rows
-- disappear with the table; admins who disabled marketplace via
-- marketplaceEnabled=0 retain that setting because it's stored in
-- app_config, not on the preset rows themselves.

DROP INDEX IF EXISTS idx_preset_templates_position;
DROP TABLE IF EXISTS preset_templates;