-- 017_automation_runtime.sql
--
-- Moves automation runtime state out of process memory and into Postgres, and
-- repairs two ON CONFLICT clauses that name constraints which never existed.
--
-- Before this migration, three in-memory stores decided whether a person had
-- already been messaged (the activity-log array, the huddle-sync cursor, and
-- the checkout Set). All three reset on restart, so a redeploy re-sent DMs that
-- had already gone out.

-- ─── 1. Durable dedupe claims ────────────────────────────────────────────────
-- One row per "this exact thing has been done". Insert succeeds = you hold the
-- claim and may act; insert conflicts = someone already did it.

CREATE TABLE IF NOT EXISTS automation_dedupe (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  dedupe_key      TEXT    NOT NULL,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (organisation_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_dedupe_expiry ON automation_dedupe (expires_at);

-- ─── 2. Durable cursors ──────────────────────────────────────────────────────
-- Replaces the module-level lastSyncTs and the per-process processedToday Set.

CREATE TABLE IF NOT EXISTS automation_cursor (
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  cursor_key      TEXT    NOT NULL,
  cursor_value    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organisation_id, cursor_key)
);

-- ─── 3. Durable activity log ─────────────────────────────────────────────────
-- Replaces the 500-entry in-memory ring buffer, which lost the dashboard's
-- history on every deploy and silently evicted same-day DM records on busy
-- channels.

CREATE TABLE IF NOT EXISTS activity_log (
  id               BIGSERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type             TEXT    NOT NULL,
  slack_user_id    TEXT,
  user_name        TEXT,
  slack_message_ts TEXT,
  jira_key         TEXT,
  action           TEXT    NOT NULL DEFAULT '',
  success          BOOLEAN NOT NULL DEFAULT TRUE,
  details          TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_recent
  ON activity_log (organisation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user_type
  ON activity_log (organisation_id, slack_user_id, type, occurred_at DESC);

-- ─── 4. sprints: the unique constraint upsertSprint already assumes ──────────
-- sprintRepository.upsertSprint issues ON CONFLICT (organisation_id, name) and
-- catches the resulting error to run a hand-rolled, non-transactional
-- select-then-write fallback that races. Collapse any duplicates, then add the
-- constraint so the upsert works as written.

DO $$
DECLARE
  dup RECORD;
  keep_id INTEGER;
BEGIN
  FOR dup IN
    SELECT organisation_id, name, MIN(id) AS survivor, ARRAY_AGG(id) AS all_ids
    FROM sprints
    GROUP BY organisation_id, name
    HAVING COUNT(*) > 1
  LOOP
    keep_id := dup.survivor;

    -- Repoint child rows that have no competing unique constraint.
    UPDATE tasks          SET sprint_id = keep_id WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;
    UPDATE standup_posts  SET sprint_id = keep_id WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;
    UPDATE deadline_events SET sprint_id = keep_id WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;
    UPDATE mismatch_events SET sprint_id = keep_id WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;
    UPDATE member_overall_stats SET best_sprint_id = keep_id WHERE best_sprint_id = ANY(dup.all_ids) AND best_sprint_id <> keep_id;

    -- These two carry their own UNIQUE(.., sprint_id, ..), so drop the losing
    -- rows rather than collide on repoint. They are recomputable aggregates.
    DELETE FROM member_daily_stats    WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;
    DELETE FROM member_sprint_summary WHERE sprint_id = ANY(dup.all_ids) AND sprint_id <> keep_id;

    DELETE FROM sprints WHERE id = ANY(dup.all_ids) AND id <> keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_org_name
  ON sprints (organisation_id, name);

-- ─── 5. deadline_events: make ON CONFLICT DO NOTHING actually do something ───
-- The table had no unique constraint, so the daily deadline job inserted a new
-- row on every run. Those duplicates inflate deadlines_total/deadlines_missed,
-- which feed the performance score.

DELETE FROM deadline_events a
USING deadline_events b
WHERE a.id > b.id
  AND a.organisation_id IS NOT DISTINCT FROM b.organisation_id
  AND a.sprint_id       IS NOT DISTINCT FROM b.sprint_id
  AND a.task_id         IS NOT DISTINCT FROM b.task_id
  AND a.due_date        IS NOT DISTINCT FROM b.due_date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deadline_unique
  ON deadline_events (organisation_id, sprint_id, task_id, due_date);

-- ─── 6. Indexes for paths that run on nearly every request ───────────────────

CREATE INDEX IF NOT EXISTS idx_members_org_active
  ON members (organisation_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sprints_org_active
  ON sprints (organisation_id, is_active);
CREATE INDEX IF NOT EXISTS idx_notifications_lookup
  ON notifications_sent (member_id, type, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_summary_org_sprint
  ON member_sprint_summary (organisation_id, sprint_id);
CREATE INDEX IF NOT EXISTS idx_standup_member_date
  ON standup_posts (member_id, post_date);
