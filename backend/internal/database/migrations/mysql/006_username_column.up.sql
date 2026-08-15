-- Add username column for separate login name
ALTER TABLE users ADD COLUMN username VARCHAR(255) UNIQUE NOT NULL;