-- 021_task_jira_fields.sql
--
-- Two fields the Jira task sync needs, and an index for the per-person queries
-- built on top of it. Additive only: nothing existing is altered or removed.
--
-- jira_updated_at  Jira's own "last updated" timestamp (comments, edits and
--                  status changes all move it). It is the honest signal for "has
--                  this stopped moving". last_synced_at cannot serve: the sync
--                  rewrites it every run, so every task would always look fresh.
-- issue_type       Bug / Story / Task / ...

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS jira_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issue_type VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_completed
  ON tasks (organisation_id, assignee_id, completed_at);
