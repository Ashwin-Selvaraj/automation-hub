-- Migration 007: Zoho attendance columns on member_daily_stats
-- Adds attendance tracking fields so the system can distinguish
-- "absent / on leave" from "present and didn't post".

ALTER TABLE member_daily_stats
  ADD COLUMN IF NOT EXISTS checked_in    BOOLEAN      DEFAULT false,
  ADD COLUMN IF NOT EXISTS check_in_time TIME,
  ADD COLUMN IF NOT EXISTS check_out_time TIME,
  ADD COLUMN IF NOT EXISTS hours_worked  NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS on_leave      BOOLEAN      DEFAULT false,
  ADD COLUMN IF NOT EXISTS leave_type    VARCHAR(100);

-- Summary table: aggregate attendance stats per member per sprint
ALTER TABLE member_sprint_summary
  ADD COLUMN IF NOT EXISTS days_present      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS days_absent       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS days_on_leave     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_arrivals     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_checkin_time  TIME,
  ADD COLUMN IF NOT EXISTS attendance_rate   NUMERIC(5,2) DEFAULT 100.00;
