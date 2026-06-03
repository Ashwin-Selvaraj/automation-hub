CREATE TABLE IF NOT EXISTS member_skill_profiles (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  skill            VARCHAR(100) NOT NULL,
  frequency        INTEGER DEFAULT 1,
  last_seen_date   DATE,
  sprint_count     INTEGER DEFAULT 1,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, member_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_skill_profiles_member
  ON member_skill_profiles(organisation_id, member_id);

CREATE INDEX IF NOT EXISTS idx_skill_profiles_skill
  ON member_skill_profiles(skill, frequency DESC);
