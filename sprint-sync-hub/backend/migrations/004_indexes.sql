CREATE INDEX IF NOT EXISTS idx_standup_member_date     ON standup_posts(member_id, post_date);
CREATE INDEX IF NOT EXISTS idx_standup_sprint          ON standup_posts(sprint_id, post_date);
CREATE INDEX IF NOT EXISTS idx_deadline_member         ON deadline_events(member_id, due_date);
CREATE INDEX IF NOT EXISTS idx_daily_stats             ON member_daily_stats(member_id, sprint_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint_assignee   ON tasks(sprint_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_transitions_task        ON task_transitions(task_id, transitioned_at);
