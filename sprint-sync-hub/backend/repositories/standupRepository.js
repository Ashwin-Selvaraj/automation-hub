'use strict';

const db = require('../db');

async function recordPost(organisationId, sprintId, memberId, slackMessageTs, postDate, messageText) {
  try {
    const wordCount = messageText ? messageText.trim().split(/\s+/).length : 0;
    const { rows } = await db.query(
      `INSERT INTO standup_posts
         (organisation_id, sprint_id, member_id, slack_message_ts, post_date, message_text, word_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slack_message_ts) DO UPDATE
         SET message_text = EXCLUDED.message_text,
             word_count = EXCLUDED.word_count
       RETURNING *`,
      [organisationId, sprintId, memberId, slackMessageTs, postDate, messageText || null, wordCount]
    );
    return rows[0];
  } catch (err) {
    console.error('[standupRepository.recordPost]', err.message);
    throw err;
  }
}

async function findByDate(organisationId, sprintId, postDate) {
  try {
    const { rows } = await db.query(
      `SELECT sp.*, m.name AS member_name, m.slack_user_id
       FROM standup_posts sp
       JOIN members m ON sp.member_id = m.id
       WHERE sp.organisation_id = $1 AND sp.sprint_id = $2 AND sp.post_date = $3`,
      [organisationId, sprintId, postDate]
    );
    return rows;
  } catch (err) {
    console.error('[standupRepository.findByDate]', err.message);
    throw err;
  }
}

async function findByMemberAndDate(memberId, postDate) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM standup_posts WHERE member_id = $1 AND post_date = $2',
      [memberId, postDate]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[standupRepository.findByMemberAndDate]', err.message);
    throw err;
  }
}

async function getMissingMembersForDate(organisationId, sprintId, postDate) {
  try {
    const { rows } = await db.query(
      `SELECT m.*
       FROM members m
       WHERE m.organisation_id = $1 AND m.is_active = true
         AND m.id NOT IN (
           SELECT member_id FROM standup_posts
           WHERE organisation_id = $1 AND sprint_id = $2 AND post_date = $3
         )`,
      [organisationId, sprintId, postDate]
    );
    return rows;
  } catch (err) {
    console.error('[standupRepository.getMissingMembersForDate]', err.message);
    throw err;
  }
}

async function updateMatchResult(standupPostId, matchedTaskId, matchConfidence, jiraUpdated) {
  try {
    const { rows } = await db.query(
      `UPDATE standup_posts
       SET matched_task_id = $1, match_confidence = $2, jira_updated = $3
       WHERE id = $4 RETURNING *`,
      [matchedTaskId || null, matchConfidence || null, jiraUpdated || false, standupPostId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[standupRepository.updateMatchResult]', err.message);
    throw err;
  }
}

async function countByMemberInSprint(memberId, sprintId) {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS count FROM standup_posts WHERE member_id = $1 AND sprint_id = $2',
      [memberId, sprintId]
    );
    return parseInt(rows[0].count, 10);
  } catch (err) {
    console.error('[standupRepository.countByMemberInSprint]', err.message);
    throw err;
  }
}

async function getPostsForMemberInSprint(memberId, sprintId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM standup_posts WHERE member_id = $1 AND sprint_id = $2 ORDER BY post_date ASC',
      [memberId, sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[standupRepository.getPostsForMemberInSprint]', err.message);
    throw err;
  }
}

module.exports = {
  recordPost, findByDate, findByMemberAndDate,
  getMissingMembersForDate, updateMatchResult,
  countByMemberInSprint, getPostsForMemberInSprint,
};
