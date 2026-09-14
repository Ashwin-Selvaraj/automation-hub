'use strict';

const db = require('../db');

/**
 * Queries behind the delivery-risk signals: throughput, work in progress, and
 * scope added after a sprint started.
 *
 * All of it comes from the tasks the sync already writes. Nothing here needs a
 * new integration or a new thing for anyone to fill in.
 */

/** Tasks completed per day so far in the sprint, oldest first. */
async function completionsByDay(organisationId, sprintId) {
  const { rows } = await db.query(
    `SELECT completed_at::date AS day, COUNT(*)::int AS finished
     FROM tasks
     WHERE organisation_id = $1 AND sprint_id = $2 AND completed_at IS NOT NULL
     GROUP BY completed_at::date
     ORDER BY day ASC`,
    [organisationId, sprintId]
  );
  return rows;
}

/** Open vs finished counts for the sprint. */
async function openAndDone(organisationId, sprintId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE completed_at IS NULL)     AS open,
       COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS done,
       COUNT(*) FILTER (WHERE completed_at IS NULL AND assignee_id IS NULL) AS unassigned
     FROM tasks
     WHERE organisation_id = $1 AND sprint_id = $2`,
    [organisationId, sprintId]
  );
  const r = rows[0] || {};
  return {
    open:       parseInt(r.open || 0, 10),
    done:       parseInt(r.done || 0, 10),
    unassigned: parseInt(r.unassigned || 0, 10),
  };
}

/**
 * Open, started work per person — the "how many things is this person holding
 * at once" count. Tasks still in a to-do state don't count; nobody is
 * context-switching across a backlog.
 */
async function openWorkPerMember(organisationId, sprintId) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.slack_user_id,
            COUNT(*)::int AS in_flight,
            ARRAY_AGG(t.jira_key ORDER BY t.due_date NULLS LAST) AS keys
     FROM tasks t
     JOIN members m ON m.id = t.assignee_id
     WHERE t.organisation_id = $1 AND t.sprint_id = $2
       AND t.completed_at IS NULL
       AND LOWER(t.status) NOT IN ('to do', 'todo', 'backlog', 'done', 'closed')
     GROUP BY m.id, m.name, m.slack_user_id
     ORDER BY in_flight DESC`,
    [organisationId, sprintId]
  );
  return rows;
}

/**
 * Tasks whose Jira creation date falls after the sprint began.
 *
 * Jira only gives a date, not a timestamp, so work created on the start date
 * itself is treated as planned rather than added — the alternative would flag
 * every sprint's own planning session as scope creep.
 */
async function addedAfterStart(organisationId, sprintId, startDate) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.status, t.created_at_jira, t.completed_at,
            m.name AS assignee
     FROM tasks t
     LEFT JOIN members m ON m.id = t.assignee_id
     WHERE t.organisation_id = $1 AND t.sprint_id = $2
       AND t.created_at_jira IS NOT NULL
       AND t.created_at_jira > $3::date
     ORDER BY t.created_at_jira DESC
     LIMIT 25`,
    [organisationId, sprintId, startDate]
  );
  return rows;
}

module.exports = { completionsByDay, openAndDone, openWorkPerMember, addedAfterStart };
