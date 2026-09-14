'use strict';

const db          = require('../../db');
const idempotency = require('../../core/idempotency');
const auditLog    = require('../../core/auditLog');
const { daily }   = require('../schedule');

const RUN_HISTORY_DAYS = 90;
const AUDIT_LOG_DAYS   = 90;

/**
 * Trims the tables the automations write to on every run.
 *
 * Dedupe claims are only meaningful until they expire, and neither the audit
 * log nor the run history is worth keeping forever.
 */
async function run({ orgId }) {
  const claims = await idempotency.purgeExpired();
  const logs   = await auditLog.purgeOlderThan(AUDIT_LOG_DAYS);

  const { rowCount: runs } = await db.query(
    `DELETE FROM automation_runs
     WHERE organisation_id = $1 AND started_at < NOW() - ($2 || ' days')::interval`,
    [orgId, RUN_HISTORY_DAYS]
  );

  return { expiredClaims: claims, oldLogRows: logs, oldRunRows: runs };
}

module.exports = {
  key:         'housekeeping',
  name:        'Housekeeping',
  description: 'Clears expired deduplication claims and trims the activity log and run history.',
  category:    'system',
  audience:    'system',
  defaultEnabled: true,
  schedule: () => daily('03:30', '03:30'),
  run,
};
