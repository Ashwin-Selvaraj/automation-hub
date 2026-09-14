'use strict';

const db = require('../db');

/**
 * Queries behind the daily lead brief.
 *
 * Everything here is a fact the system already records. The brief's job is to
 * put them in front of one person each morning instead of messaging five people
 * about them individually.
 */

/** Standups posted on a given date, with whether each matched a Jira task. */
async function standupsOn(organisationId, date) {
  const { rows } = await db.query(
    `SELECT sp.member_id, m.name, m.slack_user_id,
            sp.message_text, sp.matched_task_id, sp.post_date,
            t.jira_key AS matched_key
     FROM standup_posts sp
     JOIN members m ON m.id = sp.member_id
     LEFT JOIN tasks t ON t.id = sp.matched_task_id
     WHERE sp.organisation_id = $1 AND sp.post_date = $2
     ORDER BY m.name`,
    [organisationId, date]
  );
  return rows;
}

/** Active members who posted nothing on the given date. */
async function silentOn(organisationId, date) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.slack_user_id
     FROM members m
     WHERE m.organisation_id = $1 AND m.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM standup_posts sp
         WHERE sp.member_id = m.id AND sp.post_date = $2
       )
     ORDER BY m.name`,
    [organisationId, date]
  );
  return rows;
}

/** Open tasks past their due date, oldest first. */
async function overdueTasks(organisationId, sprintId) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.status, t.due_date, m.name AS assignee,
            (CURRENT_DATE - t.due_date) AS days_overdue
     FROM tasks t
     LEFT JOIN members m ON m.id = t.assignee_id
     WHERE t.organisation_id = $1
       AND ($2::int IS NULL OR t.sprint_id = $2)
       AND t.due_date IS NOT NULL
       AND t.due_date < CURRENT_DATE
       AND t.completed_at IS NULL
     ORDER BY t.due_date ASC
     LIMIT 25`,
    [organisationId, sprintId]
  );
  return rows;
}

/** Tasks due within the next `days` days that are not finished yet. */
async function dueSoon(organisationId, sprintId, days = 2) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.status, t.due_date, m.name AS assignee,
            (t.due_date - CURRENT_DATE) AS days_until
     FROM tasks t
     LEFT JOIN members m ON m.id = t.assignee_id
     WHERE t.organisation_id = $1
       AND ($2::int IS NULL OR t.sprint_id = $2)
       AND t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $3::int
       AND t.completed_at IS NULL
     ORDER BY t.due_date ASC
     LIMIT 25`,
    [organisationId, sprintId, days]
  );
  return rows;
}

/**
 * Tasks sitting in an in-progress state with no recorded transition for
 * `days` days. Work that has stopped moving without anyone saying so is the
 * signal a lead most often misses.
 */
async function staleInProgress(organisationId, sprintId, days = 3) {
  const { rows } = await db.query(
    `SELECT t.jira_key, t.title, t.status, m.name AS assignee,
            GREATEST(
              COALESCE(MAX(tr.transitioned_at), t.last_synced_at, t.created_at_jira),
              t.created_at_jira
            ) AS last_movement
     FROM tasks t
     LEFT JOIN members m ON m.id = t.assignee_id
     LEFT JOIN task_transitions tr ON tr.task_id = t.id
     WHERE t.organisation_id = $1
       AND ($2::int IS NULL OR t.sprint_id = $2)
       AND t.completed_at IS NULL
       AND LOWER(t.status) NOT IN ('to do', 'todo', 'backlog', 'done', 'closed')
     GROUP BY t.id, t.jira_key, t.title, t.status, m.name, t.last_synced_at, t.created_at_jira
     HAVING GREATEST(
              COALESCE(MAX(tr.transitioned_at), t.last_synced_at, t.created_at_jira),
              t.created_at_jira
            ) < NOW() - ($3 || ' days')::interval
     ORDER BY last_movement ASC
     LIMIT 25`,
    [organisationId, sprintId, days]
  );
  return rows;
}

/** Unresolved off-plan work recorded since `since`. */
async function openMismatches(organisationId, since) {
  const { rows } = await db.query(
    `SELECT me.match_type, me.mismatch_details, me.matched_issue_key,
            me.message_text, m.name
     FROM mismatch_events me
     JOIN members m ON m.id = me.member_id
     WHERE me.organisation_id = $1
       AND me.resolved = false
       AND me.created_at >= $2
     ORDER BY me.created_at DESC
     LIMIT 25`,
    [organisationId, since]
  );
  return rows;
}

/** Counts for the sprint progress line. */
async function sprintProgress(organisationId, sprintId) {
  if (!sprintId) return null;
  const { rows } = await db.query(
    `SELECT
       COUNT(*)                                        AS total,
       COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS done,
       COUNT(*) FILTER (WHERE completed_at IS NULL
                          AND LOWER(status) IN ('to do','todo','backlog')) AS not_started
     FROM tasks
     WHERE organisation_id = $1 AND sprint_id = $2`,
    [organisationId, sprintId]
  );
  const r = rows[0];
  return {
    total:      parseInt(r.total, 10),
    done:       parseInt(r.done, 10),
    notStarted: parseInt(r.not_started, 10),
  };
}

module.exports = {
  standupsOn, silentOn, overdueTasks, dueSoon,
  staleInProgress, openMismatches, sprintProgress,
};
