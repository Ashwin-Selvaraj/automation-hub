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
export const postSprintConfig = (body) => request('/api/config/sprint', { method: 'POST', body: JSON.stringify(body) });
export const postTeamMembers = (members) => request('/api/config/team', { method: 'POST', body: JSON.stringify({ members }) });

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
