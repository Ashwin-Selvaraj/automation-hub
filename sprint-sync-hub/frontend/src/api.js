import { API_BASE, apiHeaders } from './config.js';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: apiHeaders({ 'Content-Type': 'application/json', ...options.headers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.code = data.code;
    error.status = res.status;
    error.retryable = data.retryable;
    throw error;
  }
  return data;
}

export const getConfig = () => request('/api/config');
export const getHealth = () => request('/api/config/health');
export const getEnvStatus = () => request('/api/config/env-status');
export const postSprintConfig = (body) => request('/api/config/sprint', { method: 'POST', body: JSON.stringify(body) });
export const postTeamMembers = (members) => request('/api/config/team', { method: 'POST', body: JSON.stringify({ members }) });
export const postConnections = (body) => request('/api/config/connections', { method: 'POST', body: JSON.stringify(body) });

export const getSlackMessages = (days = 7) => request(`/api/slack/messages?days=${days}`);
export const sendDM = (userId, message) => request('/api/slack/dm', { method: 'POST', body: JSON.stringify({ userId, message }) });

export const getJiraIssues = () => request('/api/jira/issues');
export const getOverdueIssues = () => request('/api/jira/overdue');
export const postJiraComment = (issueKey, text) => request('/api/jira/comment', { method: 'POST', body: JSON.stringify({ issueKey, text }) });
export const postJiraTransition = (issueKey, statusName) => request('/api/jira/transition', { method: 'POST', body: JSON.stringify({ issueKey, statusName }) });

// The daily brief. Returns both the structured signals and the rendered text,
// without sending anything — so you can read today's brief before 9am.
export const getBrief = (date) => request(`/api/brief/today${date ? `?date=${date}` : ''}`);

// Automations — the catalogue is built from what the backend registry declares,
// so this list stays correct as automations are added or removed.
export const getAutomations = () => request('/api/automations');
export const setAutomationEnabled = (key, enabled) =>
  request(`/api/automations/${key}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
export const runAutomation = (key) =>
  request(`/api/automations/${key}/run`, { method: 'POST', body: JSON.stringify({}) });

export const runSync = () => request('/api/sync/run', { method: 'POST' });
export const getSyncLog = (limit = 50) => request(`/api/sync/log?limit=${limit}`);

export const generateReport = (weekIndex = 0) => request('/api/report/generate', { method: 'POST', body: JSON.stringify({ weekIndex }) });
export const postReport = (report) => request('/api/report/post', { method: 'POST', body: JSON.stringify({ report }) });

// Roles
export const getRoles       = (type) => request(`/api/roles${type ? `?type=${type}` : ''}`);
export const createRole     = (body) => request('/api/roles', { method: 'POST', body: JSON.stringify(body) });
export const updateRole     = (roleId, body) => request(`/api/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteRole     = (roleId) => request(`/api/roles/${roleId}`, { method: 'DELETE' });
export const getRoleMembers = (roleId) => request(`/api/roles/${roleId}/members`);

// Member roles
export const getMemberRoles   = (memberId) => request(`/api/roles/members/${memberId}/roles`);
export const updateMemberRoles = (memberId, roleIds) => request(`/api/roles/members/${memberId}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
export const setMemberRoles   = updateMemberRoles; // alias kept for backward compat
export const addMemberRole    = (memberId, roleId) => request(`/api/roles/members/${memberId}/roles/${roleId}`, { method: 'POST', body: JSON.stringify({}) });
export const removeMemberRole = (memberId, roleId) => request(`/api/roles/members/${memberId}/roles/${roleId}`, { method: 'DELETE', body: JSON.stringify({}) });

// Members (full data: roles + email + jira ID)
export const getMembers        = ()                            => request('/api/members');
export const getMember         = (memberId)                    => request(`/api/members/${memberId}`);
export const getJiraIdStatus   = ()                            => request('/api/members/jira-id-status');
export const setMemberJiraId   = (memberId, jiraAccountId)     => request(`/api/members/${memberId}/jira-id`, { method: 'PATCH', body: JSON.stringify({ jiraAccountId }) });
export const setMemberGithubLogin = (memberId, githubLogin) => request(`/api/members/${memberId}/github-login`, { method: 'PATCH', body: JSON.stringify({ githubLogin }) });
export const fetchSlackEmails  = ()                            => request('/api/members/fetch-slack-emails', { method: 'POST', body: JSON.stringify({}) });
export const fetchJiraIds      = ()                            => request('/api/members/fetch-jira-ids',     { method: 'POST', body: JSON.stringify({}) });
export const syncAll           = ()                            => request('/api/members/sync-all',           { method: 'POST', body: JSON.stringify({}) });

// Employee checkout uses an HttpOnly employee session cookie. The shared
// dashboard API key is never used by the backend to decide employee identity.
export const getEmployeeSession = () => request('/api/auth/slack/me');
export const startSlackSignIn = () => request('/api/auth/slack/start');
export const logoutEmployee = (csrfToken) =>
  request('/api/auth/slack/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken }, body: '{}' });
export const getEmployeeZohoStatus = () => request('/api/employee/zoho/status');
export const startEmployeeZohoConnect = (csrfToken) =>
  request('/api/employee/zoho/connect', { method: 'POST', headers: { 'x-csrf-token': csrfToken }, body: '{}' });
export const disconnectEmployeeZoho = (csrfToken) =>
  request('/api/employee/zoho/disconnect', { method: 'POST', headers: { 'x-csrf-token': csrfToken }, body: '{}' });
export const validateEmployeeCheckout = (csrfToken) =>
  request('/api/employee/checkout/validate', { method: 'POST', headers: { 'x-csrf-token': csrfToken }, body: '{}' });

// People — 1:1s, recognition and review evidence. Everything here is for the lead.
export const getPeople        = () => request('/api/people');
export const setOneOnOneSchedule = (memberId, weekday, cadence) =>
  request(`/api/people/${memberId}/schedule`, { method: 'PATCH', body: JSON.stringify({ weekday, cadence }) });
export const getOneOnOnePrep  = (memberId) => request(`/api/people/${memberId}/prep`);
export const getOneOnOnes     = (memberId) => request(`/api/people/${memberId}/one-on-ones`);
export const recordOneOnOne   = (memberId, body) =>
  request(`/api/people/${memberId}/one-on-ones`, { method: 'POST', body: JSON.stringify(body) });
export const setFollowUpDone  = (actionId, done) =>
  request(`/api/people/actions/${actionId}`, { method: 'PATCH', body: JSON.stringify({ done }) });
export const getRecognition   = (from, to) =>
  request(`/api/people/recognition${from && to ? `?from=${from}&to=${to}` : ''}`);
export const getEvidence      = (memberId, from, to) =>
  request(`/api/people/${memberId}/evidence?from=${from}&to=${to}`);

/** The evidence pack as a Markdown file. Not JSON, so it bypasses request(). */
export async function downloadEvidence(memberId, from, to) {
  const res = await fetch(`${API_BASE}/api/people/${memberId}/evidence?from=${from}&to=${to}&format=md`, {
    credentials: 'include',
    headers: apiHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  // Cross-origin, Content-Disposition is only readable if CORS exposes it.
  const disposition = res.headers.get('Content-Disposition') || '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || `review-evidence-${from}-to-${to}.md`;
  return { name, text: await res.text() };
}
