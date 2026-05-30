CREATE TABLE IF NOT EXISTS standup_posts (
  id                 SERIAL PRIMARY KEY,
  organisation_id    INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  sprint_id          INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
  member_id          INTEGER REFERENCES members(id) ON DELETE CASCADE,
  slack_message_ts   VARCHAR(50) UNIQUE,
  post_date          DATE NOT NULL,
  message_text       TEXT,
  word_count         INTEGER,
  matched_task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  match_confidence   INTEGER,
  jira_updated       BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deadline_events (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  sprint_id        INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  task_id          INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  due_date         DATE NOT NULL,
  completed_date   DATE,
  status           VARCHAR(20) NOT NULL CHECK (status IN ('hit','missed','extended','pending')),
  days_overdue     INTEGER DEFAULT 0,
  reminder_sent    BOOLEAN DEFAULT false,
  reminder_count   INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_transitions (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  task_id          INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  from_status      VARCHAR(100),
  to_status        VARCHAR(100) NOT NULL,
  triggered_by     VARCHAR(50) CHECK (triggered_by IN ('slack_sync','manual','jira_webhook','cron')),
  transitioned_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications_sent (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  type             VARCHAR(50) CHECK (type IN ('no_match_dm','deadline_reminder','missing_standup','weekly_report','deadline_overdue_3d')),
  channel          VARCHAR(20) CHECK (channel IN ('dm','channel')),
  reference_id     INTEGER,
  sent_at          TIMESTAMPTZ DEFAULT NOW(),
  delivery_status  VARCHAR(20) DEFAULT 'sent'
);
