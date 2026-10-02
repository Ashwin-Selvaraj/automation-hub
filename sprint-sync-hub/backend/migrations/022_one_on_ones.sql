-- 022_one_on_ones.sql
--
-- What a lead needs to run 1:1s well and that nothing here stored before: when
-- each person's 1:1 is, what was said last time, and what each side agreed to do.
--
-- The follow-ups are the point. A 1:1 where the lead promised "I'll ask about the
-- conference budget" and never mentions it again costs more trust than a skipped
-- one, and the next prep pack puts every open follow-up at the top.
--
-- Notes and follow-up text are written encrypted by the application (the same
-- ENCRYPTION_KEY as stored credentials), because they are the most sensitive
-- thing this database holds. Additive only: nothing existing is altered.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS one_on_one_weekday SMALLINT
    CHECK (one_on_one_weekday BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS one_on_one_cadence VARCHAR(12) NOT NULL DEFAULT 'weekly'
    CHECK (one_on_one_cadence IN ('weekly', 'fortnightly', 'monthly'));

CREATE TABLE IF NOT EXISTS one_on_ones (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  held_on          DATE NOT NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_one_on_ones_member
  ON one_on_ones (organisation_id, member_id, held_on DESC);

CREATE TABLE IF NOT EXISTS one_on_one_actions (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  one_on_one_id    INTEGER REFERENCES one_on_ones(id) ON DELETE SET NULL,
  owner            VARCHAR(10) NOT NULL CHECK (owner IN ('lead', 'member')),
  text             TEXT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  done_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_one_on_one_actions_open
  ON one_on_one_actions (organisation_id, member_id)
  WHERE done_at IS NULL;
