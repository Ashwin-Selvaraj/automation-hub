'use strict';

const db = require('../db');

async function findByMemberId(memberId) {
  const { rows } = await db.query(
    'SELECT * FROM member_zoho_connections WHERE member_id = $1',
    [memberId]
  );
  return rows[0] || null;
}

async function upsert(memberId, connection) {
  const { rows } = await db.query(
    `INSERT INTO member_zoho_connections
       (member_id, access_token_encrypted, refresh_token_encrypted,
        access_token_expires_at, zoho_user_id, zoho_email, location,
        accounts_server, api_domain, granted_scopes, status,
        last_error_code, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'connected',NULL,NOW())
     ON CONFLICT (member_id) DO UPDATE SET
       access_token_encrypted  = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       zoho_user_id             = EXCLUDED.zoho_user_id,
       zoho_email               = EXCLUDED.zoho_email,
       location                 = EXCLUDED.location,
       accounts_server          = EXCLUDED.accounts_server,
       api_domain               = EXCLUDED.api_domain,
       granted_scopes           = EXCLUDED.granted_scopes,
       status                   = 'connected',
       last_error_code          = NULL,
       connected_at             = NOW(),
       updated_at               = NOW(),
       last_verified_at         = NOW()
     RETURNING *`,
    [
      memberId, connection.accessTokenEncrypted, connection.refreshTokenEncrypted,
      connection.accessTokenExpiresAt, connection.zohoUserId, connection.zohoEmail,
      connection.location, connection.accountsServer, connection.apiDomain,
      connection.grantedScopes,
    ]
  );
  return rows[0];
}

async function updateAccessToken(memberId, accessTokenEncrypted, expiresAt, apiDomain) {
  const { rows } = await db.query(
    `UPDATE member_zoho_connections
        SET access_token_encrypted = $2,
            access_token_expires_at = $3,
            api_domain = COALESCE($4, api_domain),
            status = 'connected',
            last_error_code = NULL,
            last_verified_at = NOW(),
            updated_at = NOW()
      WHERE member_id = $1
      RETURNING *`,
    [memberId, accessTokenEncrypted, expiresAt, apiDomain || null]
  );
  return rows[0] || null;
}

async function markRevoked(memberId, errorCode) {
  await db.query(
    `UPDATE member_zoho_connections
        SET status = 'revoked', last_error_code = $2, updated_at = NOW()
      WHERE member_id = $1`,
    [memberId, String(errorCode || 'invalid_grant').slice(0, 100)]
  );
}

async function remove(memberId) {
  await db.query('DELETE FROM member_zoho_connections WHERE member_id = $1', [memberId]);
}

module.exports = { findByMemberId, upsert, updateAccessToken, markRevoked, remove };
