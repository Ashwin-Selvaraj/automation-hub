-- Migration 013: Drop legacy role column from members table.
-- All role data now lives in member_roles. The role column was a plain-text
-- holdover from before the roles system and is no longer written or read.

ALTER TABLE members DROP COLUMN IF EXISTS role;
