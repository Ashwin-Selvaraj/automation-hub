-- Migration 016: Unified attendance system
-- Adds attendance_records table (multi-source), system_config cache,
-- and per-member Zoho ID / work start time columns.

-- Per-member Zoho identifiers and work schedule
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS zoho_iamuid     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS zoho_emp_id     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS work_start_time TIME DEFAULT '09:00:00';

-- Unified attendance records from any source
CREATE TABLE IF NOT EXISTS attendance_records (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
  attendance_date  DATE        NOT NULL,
  source           VARCHAR(20) NOT NULL
                   CHECK (source IN ('zoho_api', 'zoho_webhook', 'slack_presence')),
  checked_in       BOOLEAN     DEFAULT false,
  check_in_time    TIME,
  checked_out      BOOLEAN     DEFAULT false,
  check_out_time   TIME,
  hours_worked     NUMERIC(4,2),
  status           VARCHAR(30) DEFAULT 'present',
  -- status values: present | absent | half_day | on_leave | late
  is_late          BOOLEAN     DEFAULT false,
  late_by_minutes  INTEGER     DEFAULT 0,
  raw_data         JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, member_id, attendance_date, source)
);

CREATE INDEX IF NOT EXISTS idx_attendance_date
  ON attendance_records(organisation_id, attendance_date, member_id);

CREATE INDEX IF NOT EXISTS idx_attendance_member
  ON attendance_records(member_id, attendance_date DESC);

-- Key-value config store — used to cache the discovered Zoho endpoint
-- so the probe doesn't re-run on every server start.
CREATE TABLE IF NOT EXISTS system_config (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  config_key       VARCHAR(100) NOT NULL,
  config_value     TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organisation_id, config_key)
);
