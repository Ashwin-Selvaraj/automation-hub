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
 * Uses /search/jql (the current Jira Cloud endpoint — /search is deprecated).
 * @param {string} projectKey - Jira project key (e.g. "QG")
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<Array<{ key: string, summary: string, status: string, assigneeEmail: string, duedate: string|null, priority: string }>>}
 */
async function getSprintIssues(projectKey, startDate, endDate) {
  try {
    const client = getClient();
    const jql = `project = "${projectKey}" AND updated >= "${startDate}" AND updated <= "${endDate}" ORDER BY updated DESC`;
    const res = await client.get('/search/jql', {
      params: { jql, maxResults: 100, fields: 'summary,status,assignee,duedate,priority,issuetype' },
    });

    return (res.data.issues || []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || 'Unknown',
      assigneeEmail: issue.fields.assignee?.emailAddress || null,
      assigneeName: issue.fields.assignee?.displayName || 'Unassigned',
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
    const res = await client.get('/search/jql', {
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
        assigneeName: issue.fields.assignee?.displayName || 'Unassigned',
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

// ─── Agile client (sprint/board APIs use a different base URL) ────────────────

function getAgileClient() {
  const email   = process.env.JIRA_EMAIL;
  const token   = process.env.JIRA_API_TOKEN;
  const siteUrl = process.env.JIRA_SITE_URL;

  if (!email || !token || !siteUrl) {
    throw new Error('Jira credentials (JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE_URL) are not fully configured');
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  return axios.create({
    baseURL: `${siteUrl.replace(/\/$/, '')}/rest/agile/1.0`,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
  });
}

// Module-level caches
let _boardIdCache = null;
const _jiraAccountIdCache = new Map();

/**
 * Fetch the board ID for a project. Cached after first call.
 * @param {string} projectKey
 * @returns {Promise<number>}
 */
async function getJiraBoardId(projectKey) {
  if (_boardIdCache !== null) return _boardIdCache;
  const envBoardId = parseInt(process.env.JIRA_BOARD_ID, 10);
  if (!isNaN(envBoardId)) {
    _boardIdCache = envBoardId;
    return _boardIdCache;
  }
  try {
    const client = getAgileClient();
    const res = await client.get('/board', { params: { projectKeyOrId: projectKey } });
    const boards = res.data.values || [];
    if (!boards.length) throw new Error(`No Jira board found for project ${projectKey}`);
    _boardIdCache = boards[0].id;
    return _boardIdCache;
  } catch (err) {
    throw jiraError(err, 'getJiraBoardId');
  }
}

/**
 * Look up a Jira account ID by email address. Cached.
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function getMemberJiraAccountId(email) {
  if (_jiraAccountIdCache.has(email)) return _jiraAccountIdCache.get(email);
  try {
    const client = getClient();
    const res = await client.get('/user/search', { params: { query: email } });
    const users = res.data || [];
    const accountId = users.length > 0 ? users[0].accountId : null;
    _jiraAccountIdCache.set(email, accountId);
    return accountId;
  } catch (err) {
    console.warn(`[jiraService.getMemberJiraAccountId] Could not resolve ${email}:`, err.message);
    return null;
  }
}

/**
 * Create a new sprint on the Jira board.
 * @param {string} projectKey
 * @param {string} name
 * @param {string} startDate  - "YYYY-MM-DD"
 * @param {string} endDate    - "YYYY-MM-DD"
 * @param {number} boardId
 * @returns {Promise<{ id: number, name: string, startDate: string, endDate: string, state: string }>}
 */
async function createSprint(projectKey, name, startDate, endDate, boardId) {
  try {
    const client = getAgileClient();
    const startIso = `${startDate}T09:00:00.000Z`;
    const endIso   = `${endDate}T18:00:00.000Z`;
    const res = await client.post('/sprint', {
      name,
      startDate: startIso,
      endDate: endIso,
      originBoardId: boardId,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 403) {
      throw new Error('Jira account does not have Manage Sprints permission. Ask your Jira admin to grant it.');
    }
    const detail = err.response?.data?.errorMessages?.[0] || err.response?.data?.message || err.message;
    throw new Error(`Jira createSprint: ${detail}`);
  }
}

/**
 * Transition a sprint from "future" to "active" state.
 * @param {number} sprintId
 * @returns {Promise<boolean>}
 */
async function startSprint(sprintId) {
  try {
    const client = getAgileClient();
    await client.post(`/sprint/${sprintId}`, { state: 'active' });
    return true;
  } catch (err) {
    throw jiraError(err, `startSprint(${sprintId})`);
  }
}

/**
 * Create a single Jira issue and optionally add it to a sprint.
 * @param {string}      projectKey
 * @param {string}      summary
 * @param {string}      description
 * @param {string}      priority            - "Highest"|"High"|"Medium"|"Low"
 * @param {string|null} assigneeAccountId
 * @param {string|null} dueDate             - "YYYY-MM-DD"
 * @param {number|null} sprintId
 * @param {string}      issueType           - default "Task"
 * @returns {Promise<{ key: string, id: string, summary: string, assignee: string|null }>}
 */
async function createIssue(projectKey, summary, description, priority, assigneeAccountId, dueDate, sprintId, issueType) {
  try {
    const client = getClient();

    const fields = {
      project:   { key: projectKey },
      summary,
      issuetype: { name: issueType || 'Task' },
      priority:  { name: priority || 'Medium' },
      description: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: description || summary }],
        }],
      },
    };

    if (assigneeAccountId) {
      fields.assignee = { id: assigneeAccountId };
    }
    if (dueDate) {
      fields.duedate = dueDate;
    }
    if (sprintId) {
      fields.customfield_10020 = { id: sprintId };
    }

    const res = await client.post('/issue', { fields });
    return {
      key:      res.data.key,
      id:       res.data.id,
      summary,
      assignee: assigneeAccountId || null,
    };
  } catch (err) {
    throw jiraError(err, `createIssue(${summary})`);
  }
}

/**
 * Create multiple issues sequentially with 200ms delay between each.
 * @param {Array} issues
 * @returns {Promise<Array<{ key: string, summary: string, success: boolean, error: string|null }>>}
 */
async function createIssuesBatch(issues) {
  const results = [];
  for (const issue of issues) {
    try {
      const created = await createIssue(
        issue.projectKey,
        issue.summary,
        issue.description,
        issue.priority,
        issue.assigneeAccountId,
        issue.dueDate,
        issue.sprintId,
        issue.issueType,
      );
      results.push({ key: created.key, summary: issue.summary, success: true, error: null });
    } catch (err) {
      results.push({ key: null, summary: issue.summary, success: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

module.exports = {
  getSprintIssues, addComment, transitionIssue, getOverdueIssues, testConnection,
  // Write APIs
  getJiraBoardId, getMemberJiraAccountId, createSprint, startSprint, createIssue, createIssuesBatch,
};
