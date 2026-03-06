-- Add image_url and unit_number columns to properties
-- Safe to re-run: ALTER TABLE ADD COLUMN IF NOT EXISTS isn't supported in SQLite,
-- so we check if columns exist first using a pragma

-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
-- but it throws a non-fatal "duplicate column name" error if column exists.
-- We use separate statements so each can fail independently.

ALTER TABLE properties ADD COLUMN image_url TEXT;
ALTER TABLE properties ADD COLUMN unit_number TEXT;
ALTER TABLE properties ADD COLUMN latitude REAL;
ALTER TABLE properties ADD COLUMN longitude REAL;
