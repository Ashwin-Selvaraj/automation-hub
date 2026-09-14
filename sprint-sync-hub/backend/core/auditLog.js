'use strict';

const db = require('../db');

/**
 * Durable record of every automated action.
 *
 * Replaces services/activityLog.js, which kept the last 500 entries in a plain
 * array. That had two failure modes: the dashboard lost all history on every
 * deploy, and — because the array silently evicted its oldest entries — the
 * record of a DM sent this morning could be gone by the afternoon on a busy
 * channel, which is what the old dedupe check read from.
 *
 * Deduplication now lives in core/idempotency.js. This module is the audit
 * trail only: it answers "what did the system do", not "may I act".
 *
 * Rows are shaped to match what the dashboard already renders.
 */

function toApiShape(row) {
  return {
    id:             row.id,
    timestamp:      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    type:           row.type,
    userId:         row.slack_user_id,
    userName:       row.user_name,
    slackMessageTs: row.slack_message_ts,
    jiraKey:        row.jira_key,
    action:         row.action,
    success:        row.success,
    details:        row.details || '',
  };
}

/**
 * Writes an entry. Deliberately fire-and-forget: an audit write must never
 * break the automation it is describing, and callers should not have to await
 * logging in the middle of a Slack loop.
 */
function record(organisationId, entry) {
  return db.query(
    `INSERT INTO activity_log
       (organisation_id, type, slack_user_id, user_name, slack_message_ts, jira_key, action, success, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      organisationId,
      entry.type || 'unknown',
      entry.userId || null,
      entry.userName || null,
      entry.slackMessageTs || null,
      entry.jiraKey || null,
      entry.action || '',
      entry.success !== undefined ? entry.success : true,
      entry.details || '',
    ]
  ).catch((err) => {
    console.error('[auditLog] write failed:', err.message);
  });
}

async function list(organisationId, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM activity_log
     WHERE organisation_id = $1
     ORDER BY occurred_at DESC, id DESC
     LIMIT $2`,
    [organisationId, Math.min(limit, 500)]
  );
  return rows.map(toApiShape);
}

async function listForUser(organisationId, slackUserId, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM activity_log
     WHERE organisation_id = $1 AND slack_user_id = $2
     ORDER BY occurred_at DESC, id DESC
     LIMIT $3`,
    [organisationId, slackUserId, Math.min(limit, 500)]
  );
  return rows.map(toApiShape);
}

/**
 * Slack user IDs that have a successful entry of the given type since `since`.
 * Used by the end-of-day job to tell who already had a message matched today,
 * which previously meant pulling 500 rows and filtering them in JavaScript.
 */
async function userIdsWithEntrySince(organisationId, type, since) {
  const { rows } = await db.query(
    `SELECT DISTINCT slack_user_id FROM activity_log
     WHERE organisation_id = $1 AND type = $2 AND success = TRUE
       AND occurred_at >= $3 AND slack_user_id IS NOT NULL`,
    [organisationId, type, since]
  );
  return new Set(rows.map((r) => r.slack_user_id));
}

/** Deletes entries older than `days`. Safe to call on a schedule. */
async function purgeOlderThan(days = 90) {
  const { rowCount } = await db.query(
    `DELETE FROM activity_log WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
    [days]
  );
  return rowCount;
}

module.exports = { record, list, listForUser, userIdsWithEntrySince, purgeOlderThan };
