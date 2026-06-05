import { API_BASE } from './config.js';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
export const fetchSlackEmails  = ()                            => request('/api/members/fetch-slack-emails', { method: 'POST', body: JSON.stringify({}) });
export const fetchJiraIds      = ()                            => request('/api/members/fetch-jira-ids',     { method: 'POST', body: JSON.stringify({}) });
export const syncAll           = ()                            => request('/api/members/sync-all',           { method: 'POST', body: JSON.stringify({}) });
