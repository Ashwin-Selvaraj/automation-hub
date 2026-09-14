'use strict';

const db = require('../db');

/**
 * Durable "has this already happened?" claims.
 *
 * Replaces activityLog.recentDMExists and the per-process Sets that guarded
 * outbound DMs. Those lived in process memory, so every restart re-armed every
 * automation and the team got messaged twice.
 *
 * Usage is claim-then-act, never check-then-act:
 *
 *   if (!await claim(orgId, `eod:${memberId}:${date}`, 20)) return;
 *   await sendTheThing();
 *
 * claim() is atomic — concurrent callers cannot both win, so the manual sync
 * and the cron firing at the same moment can no longer double-send.
 */

/**
 * Attempts to claim a key. Returns true if the caller now owns it (and should
 * proceed), false if someone already holds an unexpired claim.
 *
 * @param {number} organisationId
 * @param {string} key          Stable identity of the action, e.g. "eod-dm:42:2026-09-14"
 * @param {number} ttlHours     How long the claim blocks a repeat
 * @returns {Promise<boolean>}
 */
async function claim(organisationId, key, ttlHours = 24) {
  // Clear an expired claim on the same key first so the insert below can win.
  await db.query(
    'DELETE FROM automation_dedupe WHERE organisation_id = $1 AND dedupe_key = $2 AND expires_at <= NOW()',
    [organisationId, key]
  );

  const { rows } = await db.query(
    `INSERT INTO automation_dedupe (organisation_id, dedupe_key, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
     ON CONFLICT (organisation_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [organisationId, key, ttlHours]
  );

  return rows.length > 0;
}

/**
 * Releases a claim. Call this when the action the claim covered failed, so a
 * retry is not blocked by a claim for work that never actually happened.
 */
async function release(organisationId, key) {
  await db.query(
    'DELETE FROM automation_dedupe WHERE organisation_id = $1 AND dedupe_key = $2',
    [organisationId, key]
  );
}

/** Read-only check. Prefer claim() — this races if you act on the result. */
async function isClaimed(organisationId, key) {
  const { rows } = await db.query(
    'SELECT 1 FROM automation_dedupe WHERE organisation_id = $1 AND dedupe_key = $2 AND expires_at > NOW() LIMIT 1',
    [organisationId, key]
  );
  return rows.length > 0;
}

/** Drops expired rows. Safe to call on a schedule. */
async function purgeExpired() {
  const { rowCount } = await db.query('DELETE FROM automation_dedupe WHERE expires_at <= NOW()');
  return rowCount;
}

module.exports = { claim, release, isClaimed, purgeExpired };
