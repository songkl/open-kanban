-- Add access_token column to attachments table for token-based public access
ALTER TABLE attachments ADD COLUMN access_token VARCHAR(255);
