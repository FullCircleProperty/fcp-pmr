-- Add property name column
ALTER TABLE properties ADD COLUMN name TEXT DEFAULT '';
-- Add county column if not exists
ALTER TABLE properties ADD COLUMN county TEXT DEFAULT '';
