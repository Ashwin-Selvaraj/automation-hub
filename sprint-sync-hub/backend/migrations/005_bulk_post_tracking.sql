-- Track bulk/late standup posts (multiple days posted in a single message)
ALTER TABLE member_daily_stats
  ADD COLUMN IF NOT EXISTS is_bulk_post         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS bulk_post_actual_date DATE;

-- Track bulk posts at sprint summary level
ALTER TABLE member_sprint_summary
  ADD COLUMN IF NOT EXISTS bulk_standup_posts INTEGER DEFAULT 0;
