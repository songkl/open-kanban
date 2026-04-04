-- Add username column for separate login name
ALTER TABLE users ADD COLUMN username TEXT UNIQUE NOT NULL;