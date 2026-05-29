'use strict';

require('dotenv').config();
const axios = require('axios');

/**
 * Returns a configured axios instance for Jira REST API v3.
 * @returns {import('axios').AxiosInstance}
 */
function getClient() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const siteUrl = process.env.JIRA_SITE_URL;

  if (!email || !token || !siteUrl) {
    throw new Error('Jira credentials (JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE_URL) are not fully configured');
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  return axios.create({
    baseURL: `${siteUrl.replace(/\/$/, '')}/rest/api/3`,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
  });
}

/**
 * Converts a Jira API error to a clean human-readable message.
 * @param {Error} err
 * @param {string} context
 * @returns {Error}
 */
function jiraError(err, context) {
  if (err.response) {
    const status = err.response.status;
    if (status === 401) return new Error(`Jira ${context}: Invalid credentials (401)`);
    if (status === 403) return new Error(`Jira ${context}: Insufficient permissions (403)`);
    if (status === 404) return new Error(`Jira ${context}: Resource not found (404)`);
    const detail = err.response.data?.errorMessages?.[0] || err.response.data?.message || status;
    return new Error(`Jira ${context}: ${detail}`);
  }
  return new Error(`Jira ${context}: ${err.message}`);
}

/**
 * Fetches issues in a project that were updated within the sprint date range.
 * @param {string} projectKey - Jira project key (e.g. "QG")
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<Array<{ key: string, summary: string, status: string, assigneeEmail: string, duedate: string|null, priority: string }>>}
 */
async function getSprintIssues(projectKey, startDate, endDate) {
  try {
    const client = getClient();
    const jql = `project = "${projectKey}" AND updated >= "${startDate}" AND updated <= "${endDate}" ORDER BY updated DESC`;
    const res = await client.get('/search', {
      params: { jql, maxResults: 100, fields: 'summary,status,assignee,duedate,priority' },
    });

    return (res.data.issues || []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || 'Unknown',
      assigneeEmail: issue.fields.assignee?.emailAddress || null,
      assigneeName: issue.fields.assignee?.displayName || null,
      duedate: issue.fields.duedate || null,
      priority: issue.fields.priority?.name || 'Medium',
    }));
  } catch (err) {
    throw jiraError(err, 'getSprintIssues');
  }
}

/**
 * Posts a comment to a Jira issue.
 * @param {string} issueKey - e.g. "QG-42"
 * @param {string} commentText - Plain text comment
 * @returns {Promise<void>}
 */
async function addComment(issueKey, commentText) {
  try {
    const client = getClient();
    await client.post(`/issue/${issueKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: commentText }],
          },
        ],
      },
    });
  } catch (err) {
    throw jiraError(err, `addComment(${issueKey})`);
  }
}

/**
 * Transitions a Jira issue to the named status (e.g. "In Progress", "Done").
 * @param {string} issueKey - e.g. "QG-42"
 * @param {string} statusName - Target status name (case-insensitive match)
 * @returns {Promise<void>}
 */
async function transitionIssue(issueKey, statusName) {
  try {
    const client = getClient();
    const res = await client.get(`/issue/${issueKey}/transitions`);
    const transitions = res.data.transitions || [];
    const match = transitions.find(
      (t) => t.name.toLowerCase() === statusName.toLowerCase()
    );

    if (!match) {
      const available = transitions.map((t) => t.name).join(', ');
      throw new Error(`No transition named "${statusName}" found. Available: ${available}`);
    }

    await client.post(`/issue/${issueKey}/transitions`, {
      transition: { id: match.id },
    });
  } catch (err) {
    if (err.message.startsWith('No transition')) throw err;
    throw jiraError(err, `transitionIssue(${issueKey})`);
  }
}

/**
 * Returns issues in the project where duedate is in the past and status is not Done.
 * @param {string} projectKey - Jira project key
 * @returns {Promise<Array<{ key: string, summary: string, status: string, assigneeEmail: string, assigneeName: string, duedate: string, daysOverdue: number, priority: string }>>}
 */
async function getOverdueIssues(projectKey) {
  try {
    const client = getClient();
    const today = new Date().toISOString().split('T')[0];
    const jql = `project = "${projectKey}" AND duedate < "${today}" AND status != Done ORDER BY duedate ASC`;
    const res = await client.get('/search', {
      params: { jql, maxResults: 50, fields: 'summary,status,assignee,duedate,priority' },
    });

    const now = Date.now();
    return (res.data.issues || []).map((issue) => {
      const dueMs = new Date(issue.fields.duedate).getTime();
      const daysOverdue = Math.floor((now - dueMs) / (1000 * 60 * 60 * 24));
      return {
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        assigneeEmail: issue.fields.assignee?.emailAddress || null,
        assigneeName: issue.fields.assignee?.displayName || null,
        duedate: issue.fields.duedate,
        daysOverdue,
        priority: issue.fields.priority?.name || 'Medium',
      };
    });
  } catch (err) {
    throw jiraError(err, 'getOverdueIssues');
  }
}

/**
 * Tests the Jira connection by fetching project info.
 * @param {string} projectKey
 * @returns {Promise<boolean>}
 */
async function testConnection(projectKey) {
  try {
    const client = getClient();
    await client.get(`/project/${projectKey}`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getSprintIssues, addComment, transitionIssue, getOverdueIssues, testConnection };
