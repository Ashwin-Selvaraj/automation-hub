-- Migration 012: Add Jira account ID tracking columns to members table.
-- jira_account_id already exists; add source and timestamp columns.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS jira_account_id_source VARCHAR(20)
    DEFAULT 'auto'
    CHECK (jira_account_id_source IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS jira_account_id_fetched_at TIMESTAMPTZ;

-- Back-fill source for any existing rows that already have a jira_account_id
UPDATE members
  SET jira_account_id_source = 'auto'
  WHERE jira_account_id IS NOT NULL
    AND jira_account_id_source IS NULL;
