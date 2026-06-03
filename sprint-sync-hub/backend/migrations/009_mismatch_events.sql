CREATE TABLE IF NOT EXISTS mismatch_events (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  sprint_id        INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  slack_message_ts VARCHAR(50),
  message_text     TEXT,
  match_type       VARCHAR(50) CHECK (match_type IN ('unassigned_task','different_project','no_match')),
  mismatch_details TEXT,
  matched_issue_key VARCHAR(50),
  member_dm_sent   BOOLEAN DEFAULT false,
  lead_alert_sent  BOOLEAN DEFAULT false,
  resolved         BOOLEAN DEFAULT false,
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mismatch_member_sprint
  ON mismatch_events(member_id, sprint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mismatch_org_sprint
  ON mismatch_events(organisation_id, sprint_id, resolved, created_at DESC);
