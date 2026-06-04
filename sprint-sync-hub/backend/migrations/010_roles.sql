-- Migration 010: Roles system
-- Creates roles, member_roles tables and member_with_roles view.

CREATE TABLE IF NOT EXISTS roles (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  name                  VARCHAR(100) NOT NULL,
  slug                  VARCHAR(100) NOT NULL,
  role_type             VARCHAR(20) NOT NULL DEFAULT 'technical'
                        CHECK (role_type IN ('technical', 'managerial')),
  receives_task_dms     BOOLEAN DEFAULT true,
  can_be_assigned_tasks BOOLEAN DEFAULT true,
  skill_keywords        TEXT[] DEFAULT '{}',
  colour                VARCHAR(7) DEFAULT '#6366F1',
  display_order         INTEGER DEFAULT 0,
  is_active             BOOLEAN DEFAULT true,
  is_system             BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, slug)
);

CREATE TABLE IF NOT EXISTS member_roles (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  role_id          INTEGER REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at      TIMESTAMPTZ DEFAULT NOW(),
  assigned_by      INTEGER REFERENCES members(id) ON DELETE SET NULL,
  is_active        BOOLEAN DEFAULT true,
  removed_at       TIMESTAMPTZ,
  removed_by       INTEGER REFERENCES members(id) ON DELETE SET NULL,
  UNIQUE(member_id, role_id, is_active)
);

CREATE INDEX IF NOT EXISTS idx_member_roles_member ON member_roles(member_id, is_active);
CREATE INDEX IF NOT EXISTS idx_member_roles_role   ON member_roles(role_id, is_active);
