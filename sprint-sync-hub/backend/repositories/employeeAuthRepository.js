'use strict';

const db = require('../db');

async function createSession({ tokenHash, csrfHash, memberId, slackTeamId, email, expiresAt }) {
  const { rows } = await db.query(
    `INSERT INTO employee_sessions
       (token_hash, csrf_hash, member_id, slack_team_id, email, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tokenHash, csrfHash, memberId, slackTeamId, email, expiresAt]
  );
  return rows[0];
}

async function findActiveSession(tokenHash) {
  const { rows } = await db.query(
    `SELECT s.*, m.organisation_id, m.slack_user_id, m.name, m.is_active
       FROM employee_sessions s
       JOIN members m ON m.id = s.member_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND m.is_active = true`,
    [tokenHash]
  );
  if (rows[0]) {
    db.query('UPDATE employee_sessions SET last_seen_at = NOW() WHERE id = $1', [rows[0].id]).catch(() => {});
  }
  return rows[0] || null;
}

async function revokeSession(sessionId) {
  await db.query(
    'UPDATE employee_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId]
  );
}

async function createOAuthState({
  provider, stateHash, employeeSessionId = null, browserHash = null,
  nonce = null, metadata = {}, expiresAt,
}) {
  const { rows } = await db.query(
    `INSERT INTO employee_oauth_states
       (provider, state_hash, employee_session_id, browser_hash, nonce, metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [provider, stateHash, employeeSessionId, browserHash, nonce, JSON.stringify(metadata), expiresAt]
  );
  return rows[0];
}

async function consumeOAuthState(provider, stateHash) {
  const { rows } = await db.query(
    `UPDATE employee_oauth_states
        SET consumed_at = NOW()
      WHERE provider = $1
        AND state_hash = $2
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING *`,
    [provider, stateHash]
  );
  return rows[0] || null;
}

async function deleteExpired() {
  await db.query(
    `DELETE FROM employee_oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`
  );
  await db.query(
    `DELETE FROM employee_sessions
      WHERE expires_at < NOW() - INTERVAL '7 days'
         OR revoked_at < NOW() - INTERVAL '7 days'`
  );
}

module.exports = {
  createSession,
  findActiveSession,
  revokeSession,
  createOAuthState,
  consumeOAuthState,
  deleteExpired,
};
