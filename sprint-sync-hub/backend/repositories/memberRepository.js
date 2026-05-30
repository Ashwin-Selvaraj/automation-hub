'use strict';

const db = require('../db');

async function findOrCreate(organisationId, slackUserId, name, email, role) {
  try {
    const { rows } = await db.query(
      `INSERT INTO members (organisation_id, slack_user_id, name, email, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organisation_id, slack_user_id) DO UPDATE
         SET name = EXCLUDED.name,
             email = COALESCE(EXCLUDED.email, members.email),
             role = COALESCE(EXCLUDED.role, members.role)
       RETURNING *`,
      [organisationId, slackUserId, name, email || null, role || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[memberRepository.findOrCreate]', err.message);
    throw err;
  }
}

async function findBySlackId(organisationId, slackUserId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM members WHERE organisation_id = $1 AND slack_user_id = $2',
      [organisationId, slackUserId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.findBySlackId]', err.message);
    throw err;
  }
}

async function findAll(organisationId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM members WHERE organisation_id = $1 AND is_active = true ORDER BY name',
      [organisationId]
    );
    return rows;
  } catch (err) {
    console.error('[memberRepository.findAll]', err.message);
    throw err;
  }
}

async function updateJiraAccountId(memberId, jiraAccountId) {
  try {
    const { rows } = await db.query(
      'UPDATE members SET jira_account_id = $1 WHERE id = $2 RETURNING *',
      [jiraAccountId, memberId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.updateJiraAccountId]', err.message);
    throw err;
  }
}

async function deactivate(memberId) {
  try {
    const { rows } = await db.query(
      'UPDATE members SET is_active = false WHERE id = $1 RETURNING *',
      [memberId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.deactivate]', err.message);
    throw err;
  }
}

module.exports = { findOrCreate, findBySlackId, findAll, updateJiraAccountId, deactivate };
