'use strict';

const db = require('../db');

async function findOrCreate(organisationId, slackUserId, name, email) {
  try {
    const { rows } = await db.query(
      `INSERT INTO members (organisation_id, slack_user_id, name, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organisation_id, slack_user_id) DO UPDATE
         SET name  = EXCLUDED.name,
             email = COALESCE(EXCLUDED.email, members.email)
       RETURNING *`,
      [organisationId, slackUserId, name, email || null]
    );
    return rows[0];
  } catch (err) {
    console.error('[memberRepository.findOrCreate]', err.message);
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

async function findById(memberId) {
  try {
    const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [memberId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.findById]', err.message);
    throw err;
  }
}

async function findBySlackUserId(organisationId, slackUserId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM members
        WHERE organisation_id = $1 AND slack_user_id = $2 AND is_active = true`,
      [organisationId, slackUserId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.findBySlackUserId]', err.message);
    throw err;
  }
}

/**
 * Update email for a member.
 */
async function updateEmail(memberId, email) {
  try {
    const { rows } = await db.query(
      'UPDATE members SET email = $1 WHERE id = $2 RETURNING *',
      [email, memberId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.updateEmail]', err.message);
    throw err;
  }
}

/**
 * Update Jira account ID (auto or manual source).
 * @param {number} memberId
 * @param {string} jiraAccountId
 * @param {'auto'|'manual'} source
 */
async function updateJiraAccountId(memberId, jiraAccountId, source = 'auto') {
  try {
    const { rows } = await db.query(
      `UPDATE members
       SET jira_account_id            = $1,
           jira_account_id_source     = $2,
           jira_account_id_fetched_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [jiraAccountId, source, memberId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[memberRepository.updateJiraAccountId]', err.message);
    throw err;
  }
}

/**
 * Manually set a Jira account ID (always sets source = 'manual').
 */
async function setManualJiraAccountId(memberId, jiraAccountId) {
  return updateJiraAccountId(memberId, jiraAccountId, 'manual');
}

/**
 * Links a member to a GitHub username, or clears the link with null.
 * Logins are unique within an organisation, case-insensitively.
 */
async function setGithubLogin(memberId, githubLogin) {
  try {
    const { rows } = await db.query(
      'UPDATE members SET github_login = $2 WHERE id = $1 RETURNING *',
      [memberId, githubLogin || null]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '23505') {
      const taken = new Error('That GitHub username is already linked to another team member');
      taken.code = 'GITHUB_LOGIN_TAKEN';
      throw taken;
    }
    console.error('[memberRepository.setGithubLogin]', err.message);
    throw err;
  }
}

module.exports = {
  findOrCreate,
  findById,
  findBySlackUserId,
  findAll,
  updateEmail,
  updateJiraAccountId,
  setManualJiraAccountId,
  setGithubLogin,
};
