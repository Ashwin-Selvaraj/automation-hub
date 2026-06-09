'use strict';

const { query } = require('../db');

const ORG_ID = parseInt(process.env.ORGANISATION_ID || '1');

let cachedFlags = {};
let cacheLoadedAt = null;
const CACHE_TTL_MS = 30 * 1000;

async function loadFlags() {
  const result = await query(
    `SELECT config_key, config_value FROM system_config WHERE organisation_id = $1`,
    [ORG_ID]
  );
  cachedFlags = {};
  result.rows.forEach(row => {
    cachedFlags[row.config_key] = row.config_value;
  });
  cacheLoadedAt = Date.now();
}

async function getFlag(key, defaultValue = 'false') {
  if (!cacheLoadedAt || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    await loadFlags();
  }
  return cachedFlags[key] ?? defaultValue;
}

async function isZohoAttendanceEnabled() {
  const val = await getFlag('zoho_attendance_enabled', 'false');
  return val === 'true';
}

async function setFlag(key, value) {
  await query(
    `INSERT INTO system_config (organisation_id, config_key, config_value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organisation_id, config_key)
     DO UPDATE SET config_value = $3, updated_at = NOW()`,
    [ORG_ID, key, value]
  );
  cacheLoadedAt = null;
}

module.exports = { isZohoAttendanceEnabled, setFlag, getFlag, loadFlags };
