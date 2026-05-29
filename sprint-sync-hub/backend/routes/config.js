'use strict';

const express = require('express');
const router = express.Router();
const { getSprintConfig, setSprintConfig, setTeamMembers } = require('../utils/sprintConfig');
const { getSprintWindow } = require('../utils/dateUtils');
const slackService = require('../services/slackService');
const jiraService = require('../services/jiraService');
const claudeService = require('../services/claudeService');

/**
 * Masks a secret string, showing a few chars at each end.
 * e.g. "xoxb-123456789-abcdef" → "xoxb-••••cdef"
 * @param {string} val
 * @returns {string}
 */
function maskSecret(val) {
  if (!val || val.length < 8) return '••••••••';
  const show = Math.min(6, Math.floor(val.length * 0.2));
  return val.slice(0, show) + '••••' + val.slice(-4);
}

/**
 * GET /api/config
 * Returns public sprint configuration (no secrets).
 */
router.get('/', (req, res) => {
  try {
    const cfg = getSprintConfig();
    const window = getSprintWindow();
    res.json({
      sprintName: cfg.sprintName,
      startDate: cfg.startDate,
      durationWeeks: cfg.durationWeeks,
      endDate: window.endStr,
      projectKey: cfg.projectKey,
      channelId: cfg.channelId,
      timezone: cfg.timezone,
      eodCheckTime: cfg.eodCheckTime,
      reportDay: cfg.reportDay,
      reportTime: cfg.reportTime,
      teamMembers: cfg.teamMembers,
      jiraSiteUrl: process.env.JIRA_SITE_URL || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/sprint
 * Updates sprint name, start date, and duration in memory.
 * Body: { sprintName, startDate, durationWeeks }
 */
router.post('/sprint', (req, res) => {
  try {
    const { sprintName, startDate, durationWeeks } = req.body;
    if (!sprintName && !startDate && !durationWeeks) {
      return res.status(400).json({ error: 'Provide at least one field to update' });
    }
    setSprintConfig({
      ...(sprintName && { sprintName }),
      ...(startDate && { startDate }),
      ...(durationWeeks && { durationWeeks: parseInt(durationWeeks, 10) }),
    });
    const window = getSprintWindow();
    res.json({ ok: true, message: 'Sprint config updated', window });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/team
 * Replaces the team members list.
 * Body: { members: Array<{ id, name, initials, role? }> }
 */
router.post('/team', (req, res) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return res.status(400).json({ error: 'members must be an array' });
    }
    setTeamMembers(members);
    res.json({ ok: true, message: 'Team members updated', members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/config/health
 * Tests all three service connections and returns their status.
 */
router.get('/health', async (req, res) => {
  const errors = {};

  const [slackOk, jiraOk, claudeOk] = await Promise.all([
    slackService.testConnection().catch((e) => { errors.slack = e.message; return false; }),
    jiraService.testConnection(getSprintConfig().projectKey).catch((e) => { errors.jira = e.message; return false; }),
    claudeService.testConnection().catch((e) => { errors.claude = e.message; return false; }),
  ]);

  res.json({ slack: slackOk, jira: jiraOk, claude: claudeOk, errors });
});

/**
 * GET /api/config/env-status
 * Returns which env vars are set. Secrets are masked — never sent in full.
 * Non-secret values (channel ID, email, URLs, project key) are returned as-is
 * so the frontend can pre-fill editable fields.
 */
router.get('/env-status', (req, res) => {
  const e = process.env;
  res.json({
    slack: {
      botToken:      { set: !!e.SLACK_BOT_TOKEN,      secret: true,  preview: e.SLACK_BOT_TOKEN      ? maskSecret(e.SLACK_BOT_TOKEN)      : null },
      channelId:     { set: !!e.SLACK_CHANNEL_ID,     secret: false, value:   e.SLACK_CHANNEL_ID     || null },
      signingSecret: { set: !!e.SLACK_SIGNING_SECRET, secret: true,  preview: e.SLACK_SIGNING_SECRET ? maskSecret(e.SLACK_SIGNING_SECRET) : null },
    },
    jira: {
      email:      { set: !!e.JIRA_EMAIL,      secret: false, value:   e.JIRA_EMAIL      || null },
      apiToken:   { set: !!e.JIRA_API_TOKEN,  secret: true,  preview: e.JIRA_API_TOKEN  ? maskSecret(e.JIRA_API_TOKEN)  : null },
      siteUrl:    { set: !!e.JIRA_SITE_URL,   secret: false, value:   e.JIRA_SITE_URL   || null },
      projectKey: { set: !!e.JIRA_PROJECT_KEY, secret: false, value: e.JIRA_PROJECT_KEY || null },
    },
    claude: {
      apiKey: { set: !!e.ANTHROPIC_API_KEY, secret: true, preview: e.ANTHROPIC_API_KEY ? maskSecret(e.ANTHROPIC_API_KEY) : null },
    },
  });
});

/**
 * POST /api/config/connections
 * Updates non-secret connection values in the runtime environment.
 * Secrets (tokens, keys) must always be changed in .env + restart.
 * Body: { channelId?, jiraEmail?, jiraSiteUrl?, projectKey? }
 */
router.post('/connections', (req, res) => {
  try {
    const { channelId, jiraEmail, jiraSiteUrl, projectKey } = req.body;
    if (channelId)   process.env.SLACK_CHANNEL_ID   = channelId;
    if (jiraEmail)   process.env.JIRA_EMAIL          = jiraEmail;
    if (jiraSiteUrl) process.env.JIRA_SITE_URL       = jiraSiteUrl;
    if (projectKey)  process.env.JIRA_PROJECT_KEY    = projectKey;

    // Also update sprint config store so getSprintConfig() stays consistent
    if (projectKey) setSprintConfig({ projectKey });

    res.json({
      ok: true,
      updated: { channelId, jiraEmail, jiraSiteUrl, projectKey },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
