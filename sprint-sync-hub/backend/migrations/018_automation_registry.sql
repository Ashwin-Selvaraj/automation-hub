-- 018_automation_registry.sql
--
-- Per-automation enable/disable and schedule overrides.
--
-- The dashboard already rendered automation toggles, but they were local React
-- state initialised to four hard-coded `true` values — turning one off changed
-- nothing about what ran. Automations now declare themselves in code and store
-- their operator-controlled state here.
--
-- A row is only written when someone changes something. An automation with no
-- row uses the defaults declared in its module, so adding a new automation
-- needs no migration.

CREATE TABLE IF NOT EXISTS automation_settings (
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  automation_key   TEXT    NOT NULL,
  enabled          BOOLEAN,
  schedule_override TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       TEXT,
  PRIMARY KEY (organisation_id, automation_key)
);

-- Every run, so the dashboard can show when an automation last fired, how long
-- it took, and whether it failed — the questions the activity log answers only
-- indirectly.
CREATE TABLE IF NOT EXISTS automation_runs (
  id               BIGSERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  automation_key   TEXT    NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  status           TEXT    NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  trigger          TEXT    NOT NULL DEFAULT 'schedule'
                     CHECK (trigger IN ('schedule', 'manual', 'boot')),
  duration_ms      INTEGER,
  summary          TEXT,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_recent
  ON automation_runs (organisation_id, automation_key, started_at DESC);
