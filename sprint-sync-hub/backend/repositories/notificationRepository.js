'use strict';

const db = require('../db');

async function recordNotification(organisationId, memberId, type, channel, referenceId) {
  try {
    const { rows } = await db.query(
      `INSERT INTO notifications_sent (organisation_id, member_id, type, channel, reference_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [organisationId, memberId, type, channel || 'dm', referenceId || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[notificationRepository.recordNotification]', err.message);
    throw err;
  }
}

async function wasNotifiedRecently(memberId, type, referenceId, withinHours) {
  try {
    const hours = withinHours || 24;
    const params = [memberId, type, hours];
    let sql = `SELECT id FROM notifications_sent
               WHERE member_id = $1 AND type = $2
                 AND sent_at > NOW() - ($3 || ' hours')::interval`;
    if (referenceId != null) {
      sql += ' AND reference_id = $4';
      params.push(referenceId);
    }
    sql += ' LIMIT 1';
    const { rows } = await db.query(sql, params);
    return rows.length > 0;
  } catch (err) {
    console.error('[notificationRepository.wasNotifiedRecently]', err.message);
    return false;
  }
}

async function getNotificationHistory(organisationId, memberId, limit) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM notifications_sent
       WHERE organisation_id = $1 AND member_id = $2
       ORDER BY sent_at DESC LIMIT $3`,
      [organisationId, memberId, limit || 50]
    );
    return rows;
  } catch (err) {
    console.error('[notificationRepository.getNotificationHistory]', err.message);
    throw err;
  }
}

async function getRecentActivity(organisationId, limit) {
  try {
    const { rows } = await db.query(
      `SELECT ns.*, m.name AS member_name
       FROM notifications_sent ns
       JOIN members m ON ns.member_id = m.id
       WHERE ns.organisation_id = $1
       ORDER BY ns.sent_at DESC LIMIT $2`,
      [organisationId, limit || 30]
    );
    return rows;
  } catch (err) {
    console.error('[notificationRepository.getRecentActivity]', err.message);
    throw err;
  }
}

module.exports = { recordNotification, wasNotifiedRecently, getNotificationHistory, getRecentActivity };
