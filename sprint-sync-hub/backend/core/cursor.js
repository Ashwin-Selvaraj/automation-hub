'use strict';

const db = require('../db');

/**
 * Durable cursors for jobs that resume where they left off.
 *
 * Replaces cron.js's module-level lastSyncTs. That variable reset to null on
 * restart, which made the next huddle sync re-read the entire sprint window —
 * re-posting Jira comments and re-sending DMs for messages already handled.
 */

async function get(organisationId, key) {
  const { rows } = await db.query(
    'SELECT cursor_value FROM automation_cursor WHERE organisation_id = $1 AND cursor_key = $2',
    [organisationId, key]
  );
  return rows.length > 0 ? rows[0].cursor_value : null;
}

async function set(organisationId, key, value) {
  await db.query(
    `INSERT INTO automation_cursor (organisation_id, cursor_key, cursor_value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organisation_id, cursor_key) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
    [organisationId, key, value == null ? null : String(value)]
  );
}

/** Reads a cursor as a number, falling back when absent or unparseable. */
async function getNumber(organisationId, key, fallback = null) {
  const raw = await get(organisationId, key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function clear(organisationId, key) {
  await db.query(
    'DELETE FROM automation_cursor WHERE organisation_id = $1 AND cursor_key = $2',
    [organisationId, key]
  );
}

module.exports = { get, set, getNumber, clear };
