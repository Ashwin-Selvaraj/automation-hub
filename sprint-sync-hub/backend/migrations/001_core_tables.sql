CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(100) PRIMARY KEY,
  run_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organisations (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  slack_channel_id  VARCHAR(50),
  jira_project_key  VARCHAR(50),
  jira_site_url     VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS members (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  slack_user_id    VARCHAR(50) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255),
  jira_account_id  VARCHAR(255),
  role             VARCHAR(100),
  is_active        BOOLEAN DEFAULT true,
  joined_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS sprints (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  duration_weeks   INTEGER NOT NULL DEFAULT 2,
  is_active        BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  sprint_id        INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
  jira_key         VARCHAR(50) NOT NULL,
  title            TEXT NOT NULL,
  status           VARCHAR(100) NOT NULL DEFAULT 'To Do',
  priority         VARCHAR(50),
  assignee_id      INTEGER REFERENCES members(id) ON DELETE SET NULL,
  due_date         DATE,
  created_at_jira  DATE,
  completed_at     TIMESTAMPTZ,
  last_synced_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, jira_key)
);
