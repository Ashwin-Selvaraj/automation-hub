'use strict';

const db = require('../db');
const crypto = require('../services/cryptoService');

/**
 * Queries behind 1:1 prep, recognition and review evidence.
 *
 * Every date window is inclusive and interpreted in the team's timezone: a task
 * closed at 00:30 IST on the 15th was closed on the 15th, even though it was
 * still the 14th in UTC.
 */

/** Tasks completed in a window, optionally for one person. */
async function completedBetween(organisationId, { from, to, timeZone, memberId = null }) {
  const { rows } = await db.query(
    `SELECT t.id, t.jira_key, t.title, t.issue_type, t.status, t.due_date,
            t.created_at_jira, t.completed_at, t.assignee_id,
            m.name AS assignee_name, s.name AS sprint_name,
            (t.completed_at AT TIME ZONE $4)::date AS completed_on
     FROM tasks t
     LEFT JOIN members m ON m.id = t.assignee_id
     LEFT JOIN sprints s ON s.id = t.sprint_id
     WHERE t.organisation_id = $1
       AND t.completed_at IS NOT NULL
       AND (t.completed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       AND ($5::int IS NULL OR t.assignee_id = $5)
     ORDER BY t.completed_at ASC`,
    [organisationId, from, to, timeZone, memberId]
  );
  return rows;
}

/**
 * Open work assigned to one person, with when it last moved. "Movement" is the
 * same definition the daily brief uses for stalled work.
 */
async function openFor(organisationId, memberId) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.status, t.due_date, t.issue_type,
            COALESCE(
              GREATEST(t.jira_updated_at, MAX(tr.transitioned_at), t.created_at_jira::timestamptz),
              t.last_synced_at
            ) AS last_movement
     FROM tasks t
     LEFT JOIN task_transitions tr ON tr.task_id = t.id
     WHERE t.organisation_id = $1 AND t.assignee_id = $2 AND t.completed_at IS NULL
     GROUP BY t.id
     ORDER BY t.due_date ASC NULLS LAST, t.jira_key`,
    [organisationId, memberId]
  );
  return rows;
}

/** Tasks with a due date inside the window, for the deadline record. */
async function dueBetween(organisationId, { from, to, timeZone, memberId }) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.due_date, t.completed_at,
            (t.completed_at AT TIME ZONE $4)::date AS completed_on
     FROM tasks t
     WHERE t.organisation_id = $1 AND t.assignee_id = $5
       AND t.due_date BETWEEN $2::date AND $3::date
     ORDER BY t.due_date`,
    [organisationId, from, to, timeZone, memberId]
  );
  return rows;
}

/** One person's standup posts in a window, newest first. */
async function standupsBetween(organisationId, { from, to, memberId }) {
  const { rows } = await db.query(
    `SELECT post_date, message_text
     FROM standup_posts
     WHERE organisation_id = $1 AND member_id = $4
       AND post_date BETWEEN $2::date AND $3::date
     ORDER BY post_date DESC, id DESC`,
    [organisationId, from, to, memberId]
  );
  return rows;
}

/** How many distinct days a person posted a standup in a window. */
async function standupDays(organisationId, { from, to, memberId }) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT post_date)::int AS days
     FROM standup_posts
     WHERE organisation_id = $1 AND member_id = $4
       AND post_date BETWEEN $2::date AND $3::date`,
    [organisationId, from, to, memberId]
  );
  return rows[0]?.days || 0;
}

// ─── 1:1 schedule ─────────────────────────────────────────────────────────────

/** Active members with a 1:1 day set, with when their last 1:1 was. */
async function scheduledMembers(organisationId) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.slack_user_id, m.github_login,
            m.one_on_one_weekday, m.one_on_one_cadence,
            (SELECT MAX(o.held_on)::text FROM one_on_ones o WHERE o.member_id = m.id) AS last_held_on
     FROM members m
     WHERE m.organisation_id = $1 AND m.is_active = true
       AND m.one_on_one_weekday IS NOT NULL
     ORDER BY m.name`,
    [organisationId]
  );
  return rows;
}

/** Every active member with their 1:1 settings, last 1:1 and open follow-ups. */
async function overview(organisationId) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.github_login, m.one_on_one_weekday, m.one_on_one_cadence,
            (SELECT MAX(o.held_on)::text FROM one_on_ones o WHERE o.member_id = m.id) AS last_held_on,
            (SELECT COUNT(*)::int FROM one_on_one_actions a
              WHERE a.member_id = m.id AND a.done_at IS NULL) AS open_actions
     FROM members m
     WHERE m.organisation_id = $1 AND m.is_active = true
     ORDER BY m.name`,
    [organisationId]
  );
  return rows;
}

async function setSchedule(organisationId, memberId, { weekday, cadence }) {
  const { rows } = await db.query(
    `UPDATE members
     SET one_on_one_weekday = $3,
         one_on_one_cadence = COALESCE($4, one_on_one_cadence)
     WHERE organisation_id = $1 AND id = $2
     RETURNING id, name, one_on_one_weekday, one_on_one_cadence`,
    [organisationId, memberId, weekday, cadence || null]
  );
  return rows[0] || null;
}

// ─── 1:1 records ──────────────────────────────────────────────────────────────

// Dates come back as YYYY-MM-DD text. pg turns a DATE into a Date at local
// midnight, which JSON then serialises as the previous day anywhere east of UTC.
function decryptOneOnOne(row) {
  return row && { ...row, notes: crypto.decrypt(row.notes) };
}

function decryptAction(row) {
  return row && { ...row, text: crypto.decrypt(row.text) };
}

async function recentOneOnOnes(organisationId, memberId, limit = 5) {
  const { rows } = await db.query(
    `SELECT id, member_id, held_on::text AS held_on, notes, created_at
     FROM one_on_ones
     WHERE organisation_id = $1 AND member_id = $2
     ORDER BY held_on DESC, id DESC
     LIMIT $3`,
    [organisationId, memberId, limit]
  );
  return rows.map(decryptOneOnOne);
}

/**
 * Records a 1:1 and the follow-ups agreed in it, in one transaction so a failed
 * follow-up never leaves a 1:1 recorded without what was agreed.
 */
async function recordOneOnOne(organisationId, memberId, { heldOn, notes, actions = [] }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO one_on_ones (organisation_id, member_id, held_on, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, member_id, held_on::text AS held_on, notes, created_at`,
      [organisationId, memberId, heldOn, notes ? crypto.encrypt(notes) : null]
    );
    const oneOnOne = rows[0];

    const created = [];
    for (const action of actions) {
      const { rows: a } = await client.query(
        `INSERT INTO one_on_one_actions (organisation_id, member_id, one_on_one_id, owner, text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, member_id, one_on_one_id, owner, text, created_at, done_at`,
        [organisationId, memberId, oneOnOne.id, action.owner, crypto.encrypt(action.text)]
      );
      created.push(decryptAction(a[0]));
    }

    await client.query('COMMIT');
    return { ...decryptOneOnOne(oneOnOne), actions: created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Follow-ups not yet done, oldest first, plus any closed since `closedSince`. */
async function actionsFor(organisationId, memberId, { closedSince = null } = {}) {
  const { rows } = await db.query(
    `SELECT id, member_id, one_on_one_id, owner, text, created_at, done_at
     FROM one_on_one_actions
     WHERE organisation_id = $1 AND member_id = $2
       AND (done_at IS NULL OR ($3::timestamptz IS NOT NULL AND done_at >= $3::timestamptz))
     ORDER BY done_at IS NULL DESC, created_at ASC`,
    [organisationId, memberId, closedSince]
  );
  return rows.map(decryptAction);
}

async function setActionDone(organisationId, actionId, done) {
  const { rows } = await db.query(
    `UPDATE one_on_one_actions
     SET done_at = CASE WHEN $3::boolean THEN COALESCE(done_at, NOW()) ELSE NULL END
     WHERE organisation_id = $1 AND id = $2
     RETURNING id, member_id, one_on_one_id, owner, text, created_at, done_at`,
    [organisationId, actionId, Boolean(done)]
  );
  return decryptAction(rows[0]) || null;
}

module.exports = {
  completedBetween, openFor, dueBetween, standupsBetween, standupDays,
  scheduledMembers, overview, setSchedule,
  recentOneOnOnes, recordOneOnOne, actionsFor, setActionDone,
};
