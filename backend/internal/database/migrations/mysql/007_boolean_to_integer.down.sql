-- Revert boolean config values from 1/0 back to "true"/"false" strings

-- Convert allowRegistration
UPDATE app_config SET value = 'true' WHERE key = 'allowRegistration' AND value = '1';
UPDATE app_config SET value = 'false' WHERE key = 'allowRegistration' AND value = '0';

-- Convert requirePassword
UPDATE app_config SET value = 'true' WHERE key = 'requirePassword' AND value = '1';
UPDATE app_config SET value = 'false' WHERE key = 'requirePassword' AND value = '0';

-- Convert authEnabled
UPDATE app_config SET value = 'true' WHERE key = 'authEnabled' AND value = '1';
UPDATE app_config SET value = 'false' WHERE key = 'authEnabled' AND value = '0';