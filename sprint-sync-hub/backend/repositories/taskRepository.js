'use strict';

const db = require('../db');
const teamClock = require('../utils/teamClock');

const DONE_STATUSES = ['done', 'closed', 'resolved', 'complete', 'completed'];

function isDone(status) {
  return DONE_STATUSES.includes((status || '').toLowerCase());
}

async function upsertTask(organisationId, sprintId, jiraKey, title, status, priority, assigneeId, dueDate, createdAtJira) {
  try {
    const completedAt = isDone(status) ? 'NOW()' : null;
    const { rows } = await db.query(
      `INSERT INTO tasks
         (organisation_id, sprint_id, jira_key, title, status, priority, assignee_id, due_date, created_at_jira, completed_at, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${completedAt ? 'NOW()' : 'NULL'}, NOW())
       ON CONFLICT (organisation_id, jira_key) DO UPDATE
         SET title = EXCLUDED.title,
             status = EXCLUDED.status,
             priority = EXCLUDED.priority,
             assignee_id = COALESCE(EXCLUDED.assignee_id, tasks.assignee_id),
             due_date = COALESCE(EXCLUDED.due_date, tasks.due_date),
             sprint_id = COALESCE(EXCLUDED.sprint_id, tasks.sprint_id),
             completed_at = CASE
               WHEN ${isDone(status) ? 'true' : 'false'} AND tasks.completed_at IS NULL THEN NOW()
               ELSE tasks.completed_at
             END,
             last_synced_at = NOW()
       RETURNING *`,
      [organisationId, sprintId, jiraKey, title, status, priority || null, assigneeId || null, dueDate || null, createdAtJira || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[taskRepository.upsertTask]', err.message);
    throw err;
  }
}

/**
 * Writes one issue as Jira reports it. Jira is the source of truth here, which is
 * why — unlike upsertTask, which only ever adds — this overwrites the assignee and
 * due date outright, including with NULL when Jira has cleared them.
 *
 * Completion:
 *   done      → Jira's own resolution date when it has one, so a task finished
 *               months ago and first seen today is dated when it was really
 *               finished, not when this system happened to notice. Otherwise the
 *               earlier recorded time, otherwise now.
 *   not done  → NULL, so a reopened task stops counting as finished.
 *
 * `sprintId` only ever attaches: a null leaves an existing attachment alone, so a
 * task that has since left the active sprint keeps the sprint it was in.
 *
 * @returns {Promise<{ id: number, inserted: boolean }>}
 */
async function syncFromJira(organisationId, t) {
  try {
    const { rows } = await db.query(
      `INSERT INTO tasks
         (organisation_id, sprint_id, jira_key, title, status, priority, assignee_id,
          due_date, created_at_jira, completed_at, last_synced_at, jira_updated_at, issue_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $10::boolean THEN COALESCE($11::timestamptz, NOW()) ELSE NULL END,
               NOW(), $12::timestamptz, $13)
       ON CONFLICT (organisation_id, jira_key) DO UPDATE SET
         title           = EXCLUDED.title,
         status          = EXCLUDED.status,
         priority        = EXCLUDED.priority,
         assignee_id     = EXCLUDED.assignee_id,
         due_date        = EXCLUDED.due_date,
         created_at_jira = COALESCE(EXCLUDED.created_at_jira, tasks.created_at_jira),
         sprint_id       = COALESCE(EXCLUDED.sprint_id, tasks.sprint_id),
         completed_at    = CASE WHEN $10::boolean
                                THEN COALESCE($11::timestamptz, tasks.completed_at, NOW())
                                ELSE NULL END,
         last_synced_at  = NOW(),
         jira_updated_at = EXCLUDED.jira_updated_at,
         issue_type      = EXCLUDED.issue_type
       RETURNING id, (xmax = 0) AS inserted`,
      [
        organisationId,
        t.sprintId || null,
        t.jiraKey,
        t.title,
        // Clipped to the column widths so one oddly long value cannot fail a sync.
        String(t.status || 'To Do').slice(0, 100),
        t.priority ? String(t.priority).slice(0, 50) : null,
        t.assigneeId || null,
        t.dueDate || null,
        t.createdOn || null,
        Boolean(t.isDone),
        t.resolvedAt || null,
        t.updatedAt || null,
        t.issueType ? String(t.issueType).slice(0, 50) : null,
      ]
    );
    return { id: rows[0].id, inserted: rows[0].inserted === true };
  } catch (err) {
    console.error('[taskRepository.syncFromJira]', t.jiraKey, err.message);
    throw err;
  }
}

async function findBySprintAndAssignee(sprintId, assigneeId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM tasks WHERE sprint_id = $1 AND assignee_id = $2 ORDER BY due_date ASC NULLS LAST',
      [sprintId, assigneeId]
    );
    return rows;
  } catch (err) {
    console.error('[taskRepository.findBySprintAndAssignee]', err.message);
    throw err;
  }
}

async function findByJiraKey(organisationId, jiraKey) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM tasks WHERE organisation_id = $1 AND jira_key = $2',
      [organisationId, jiraKey]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[taskRepository.findByJiraKey]', err.message);
    throw err;
  }
}

async function markCompleted(taskId) {
  try {
    const { rows } = await db.query(
      `UPDATE tasks SET status = 'Done', completed_at = NOW()
       WHERE id = $1 AND completed_at IS NULL RETURNING *`,
      [taskId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[taskRepository.markCompleted]', err.message);
    throw err;
  }
}

async function getOverdueTasks(organisationId, sprintId, today = teamClock.today()) {
  try {
    const { rows } = await db.query(
      `SELECT t.*, m.slack_user_id, m.name AS assignee_name, m.email AS assignee_email
       FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.id
       WHERE t.organisation_id = $1
         AND t.sprint_id = $2
         AND t.due_date < $3::date
         AND t.completed_at IS NULL
       ORDER BY t.due_date ASC`,
      [organisationId, sprintId, today]
    );
    return rows;
  } catch (err) {
    console.error('[taskRepository.getOverdueTasks]', err.message);
    throw err;
  }
}

async function countByStatus(sprintId, assigneeId) {
  try {
    const { rows } = await db.query(
      `SELECT status, COUNT(*) AS count
       FROM tasks
       WHERE sprint_id = $1 AND assignee_id = $2
       GROUP BY status`,
      [sprintId, assigneeId]
    );
    const result = { total: 0, completed: 0, inProgress: 0, notStarted: 0 };
    for (const row of rows) {
      const n = parseInt(row.count, 10);
      result.total += n;
      const s = (row.status || '').toLowerCase();
      if (isDone(s)) result.completed += n;
      else if (s.includes('progress') || s.includes('review')) result.inProgress += n;
      else result.notStarted += n;
    }
    return result;
  } catch (err) {
    console.error('[taskRepository.countByStatus]', err.message);
    throw err;
  }
}

async function getIncompleteTasksBySprint(sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT t.*, m.name AS assignee_name
       FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.id
       WHERE t.sprint_id = $1 AND t.completed_at IS NULL
       ORDER BY t.due_date ASC NULLS LAST`,
      [sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[taskRepository.getIncompleteTasksBySprint]', err.message);
    throw err;
  }
}

async function getByIds(organisationId, taskIds) {
  if (!taskIds || taskIds.length === 0) return [];
  try {
    const { rows } = await db.query(
      `SELECT t.*, m.name AS assignee_name
       FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.id
       WHERE t.id = ANY($1::int[]) AND t.organisation_id = $2`,
      [taskIds, organisationId]
    );
    return rows;
  } catch (err) {
    console.error('[taskRepository.getByIds]', err.message);
    throw err;
  }
}

async function getActiveTaskCountsPerMember(organisationId) {
  try {
    const { rows } = await db.query(
      `SELECT assignee_id, COUNT(*) AS task_count
       FROM tasks
       WHERE organisation_id = $1
         AND LOWER(status) NOT IN ('done', 'closed', 'resolved', 'complete', 'completed')
         AND assignee_id IS NOT NULL
       GROUP BY assignee_id`,
      [organisationId]
    );
    const counts = {};
    for (const row of rows) counts[row.assignee_id] = parseInt(row.task_count, 10);
    return counts;
  } catch (err) {
    console.error('[taskRepository.getActiveTaskCountsPerMember]', err.message);
    throw err;
  }
}

module.exports = { upsertTask, syncFromJira, findBySprintAndAssignee, findByJiraKey, markCompleted, getOverdueTasks, countByStatus, getActiveTaskCountsPerMember, getIncompleteTasksBySprint, getByIds };
