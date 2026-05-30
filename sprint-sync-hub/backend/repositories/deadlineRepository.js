'use strict';

const db = require('../db');

async function recordDeadlineEvent(organisationId, sprintId, memberId, taskId, dueDate, status, daysOverdue) {
  try {
    const { rows } = await db.query(
      `INSERT INTO deadline_events
         (organisation_id, sprint_id, member_id, task_id, due_date, status, days_overdue)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [organisationId, sprintId, memberId, taskId, dueDate, status, daysOverdue || 0]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[deadlineRepository.recordDeadlineEvent]', err.message);
    throw err;
  }
}

async function getByMemberAndSprint(memberId, sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT de.*, t.jira_key, t.title AS task_title
       FROM deadline_events de
       JOIN tasks t ON de.task_id = t.id
       WHERE de.member_id = $1 AND de.sprint_id = $2
       ORDER BY de.due_date ASC`,
      [memberId, sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[deadlineRepository.getByMemberAndSprint]', err.message);
    throw err;
  }
}

async function updateStatus(deadlineEventId, status, completedDate, daysOverdue) {
  try {
    const { rows } = await db.query(
      `UPDATE deadline_events
       SET status = $1, completed_date = $2, days_overdue = $3
       WHERE id = $4 RETURNING *`,
      [status, completedDate || null, daysOverdue || 0, deadlineEventId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[deadlineRepository.updateStatus]', err.message);
    throw err;
  }
}

async function incrementReminderCount(deadlineEventId) {
  try {
    const { rows } = await db.query(
      `UPDATE deadline_events
       SET reminder_sent = true, reminder_count = reminder_count + 1
       WHERE id = $1 RETURNING *`,
      [deadlineEventId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[deadlineRepository.incrementReminderCount]', err.message);
    throw err;
  }
}

async function getMissedDeadlines(organisationId, sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT de.*, t.jira_key, t.title AS task_title, m.name AS member_name
       FROM deadline_events de
       JOIN tasks t ON de.task_id = t.id
       JOIN members m ON de.member_id = m.id
       WHERE de.organisation_id = $1 AND de.sprint_id = $2 AND de.status = 'missed'
       ORDER BY de.days_overdue DESC`,
      [organisationId, sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[deadlineRepository.getMissedDeadlines]', err.message);
    throw err;
  }
}

async function findByTaskId(taskId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM deadline_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
      [taskId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[deadlineRepository.findByTaskId]', err.message);
    throw err;
  }
}

module.exports = {
  recordDeadlineEvent, getByMemberAndSprint,
  updateStatus, incrementReminderCount,
  getMissedDeadlines, findByTaskId,
};
