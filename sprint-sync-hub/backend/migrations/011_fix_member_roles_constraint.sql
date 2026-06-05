-- Migration 011: Fix member_roles UNIQUE constraint
-- The old constraint UNIQUE(member_id, role_id, is_active) allows the same
-- member+role pair to appear twice (once active, once inactive), which causes
-- silent failures on ON CONFLICT upserts.
-- Replace with a single UNIQUE(member_id, role_id) so there is ever only
-- one row per member+role combination.

ALTER TABLE member_roles
  DROP CONSTRAINT IF EXISTS member_roles_member_id_role_id_is_active_key;

ALTER TABLE member_roles
  ADD CONSTRAINT member_roles_member_id_role_id_key
  UNIQUE (member_id, role_id);
