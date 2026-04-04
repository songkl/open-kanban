-- Convert boolean config values from "true"/"false" strings to 1/0 integers
-- This improves query efficiency and enables proper indexing

-- Convert allowRegistration
UPDATE app_config SET value = '1' WHERE key = 'allowRegistration' AND value = 'true';
UPDATE app_config SET value = '0' WHERE key = 'allowRegistration' AND value = 'false';

-- Convert requirePassword
UPDATE app_config SET value = '1' WHERE key = 'requirePassword' AND value = 'true';
UPDATE app_config SET value = '0' WHERE key = 'requirePassword' AND value = 'false';

-- Convert authEnabled
UPDATE app_config SET value = '1' WHERE key = 'authEnabled' AND value = 'true';
UPDATE app_config SET value = '0' WHERE key = 'authEnabled' AND value = 'false';