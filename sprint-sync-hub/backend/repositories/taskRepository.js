'use strict';

const db = require('../db');

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

async function getOverdueTasks(organisationId, sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT t.*, m.slack_user_id, m.name AS assignee_name, m.email AS assignee_email
       FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.id
       WHERE t.organisation_id = $1
         AND t.sprint_id = $2
         AND t.due_date < CURRENT_DATE
         AND t.completed_at IS NULL
       ORDER BY t.due_date ASC`,
      [organisationId, sprintId]
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

module.exports = { upsertTask, findByJiraKey, findBySprintAndAssignee, markCompleted, getOverdueTasks, countByStatus, getActiveTaskCountsPerMember };
