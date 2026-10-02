CREATE TABLE IF NOT EXISTS employee_sessions (
  id             BIGSERIAL PRIMARY KEY,
  token_hash     CHAR(64) NOT NULL UNIQUE,
  csrf_hash      CHAR(64) NOT NULL,
  member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  slack_team_id  VARCHAR(50) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_sessions_member
  ON employee_sessions(member_id, expires_at);

CREATE TABLE IF NOT EXISTS employee_oauth_states (
  id                   BIGSERIAL PRIMARY KEY,
  provider             VARCHAR(20) NOT NULL CHECK (provider IN ('slack', 'zoho')),
  state_hash           CHAR(64) NOT NULL UNIQUE,
  employee_session_id  BIGINT REFERENCES employee_sessions(id) ON DELETE CASCADE,
  browser_hash         CHAR(64),
  nonce                VARCHAR(255),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_oauth_states_expiry
  ON employee_oauth_states(provider, expires_at);

CREATE TABLE IF NOT EXISTS member_zoho_connections (
  member_id               INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  access_token_encrypted  TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ,
  zoho_user_id            VARCHAR(255),
  zoho_email              VARCHAR(255) NOT NULL,
  location                VARCHAR(32),
  accounts_server         VARCHAR(255) NOT NULL,
  api_domain              VARCHAR(255),
  granted_scopes          TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'connected'
                          CHECK (status IN ('connected', 'revoked', 'error')),
  last_error_code         VARCHAR(100),
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_zoho_user
  ON member_zoho_connections(zoho_user_id)
  WHERE zoho_user_id IS NOT NULL;
