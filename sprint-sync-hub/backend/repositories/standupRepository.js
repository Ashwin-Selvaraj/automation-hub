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
  recordPost, findByMemberAndDate,
  getPostsForMemberInSprint,
};
