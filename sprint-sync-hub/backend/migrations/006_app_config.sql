-- Central config store — one row per setting key
-- Secrets are stored AES-256-GCM encrypted; plaintext values are stored as-is.
CREATE TABLE IF NOT EXISTS app_config (
  key          TEXT PRIMARY KEY,
  value        TEXT,
  is_encrypted BOOLEAN NOT NULL DEFAULT false,
  category     TEXT    NOT NULL DEFAULT 'general',
  label        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log of config changes (who changed what, when)
CREATE TABLE IF NOT EXISTS config_audit (
  id         SERIAL PRIMARY KEY,
  key        TEXT NOT NULL,
  old_value  TEXT,           -- always masked/null for secrets
  new_value  TEXT,           -- always masked/null for secrets
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source     TEXT NOT NULL DEFAULT 'api'  -- 'api' | 'seed' | 'migration'
);

CREATE INDEX IF NOT EXISTS idx_config_category ON app_config(category);
CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit(key);
