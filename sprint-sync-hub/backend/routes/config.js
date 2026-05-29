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
 * Non-secret values are returned as-is so the frontend can pre-fill editable fields.
 * Covers every variable in .env.example.
 */
router.get('/env-status', (req, res) => {
  const e = process.env;

  // Parse team members with the same lenient logic as sprintConfig
  let parsedTeam = [];
  let teamParseError = false;
  const rawTeam = e.TEAM_MEMBERS || '';
  if (rawTeam.trim()) {
    try {
      const direct = JSON.parse(rawTeam);
      parsedTeam = Array.isArray(direct) ? direct : [];
    } catch {
      try {
        const cleaned = rawTeam
          .replace(/\\\s*[\r\n]+\s*/g, '')
          .replace(/[\r\n\t]/g, ' ')
          .replace(/,\s*([}\]])/g, '$1')
          .trim();
        const fallback = JSON.parse(cleaned);
        parsedTeam = Array.isArray(fallback) ? fallback : [];
      } catch {
        teamParseError = true;
        parsedTeam = [];
      }
    }
  }
  const teamIsPlaceholder = parsedTeam.some((m) => m.id && m.id.startsWith('U00000000'));

  res.json({
    slack: {
      botToken:      { set: !!e.SLACK_BOT_TOKEN,      secret: true,  preview: e.SLACK_BOT_TOKEN      ? maskSecret(e.SLACK_BOT_TOKEN)      : null },
      channelId:     { set: !!e.SLACK_CHANNEL_ID,     secret: false, value:   e.SLACK_CHANNEL_ID     || null },
      signingSecret: { set: !!e.SLACK_SIGNING_SECRET, secret: true,  preview: e.SLACK_SIGNING_SECRET ? maskSecret(e.SLACK_SIGNING_SECRET) : null },
    },
    jira: {
      email:      { set: !!e.JIRA_EMAIL,       secret: false, value:   e.JIRA_EMAIL       || null },
      apiToken:   { set: !!e.JIRA_API_TOKEN,   secret: true,  preview: e.JIRA_API_TOKEN   ? maskSecret(e.JIRA_API_TOKEN)   : null },
      siteUrl:    { set: !!e.JIRA_SITE_URL,    secret: false, value:   e.JIRA_SITE_URL    || null },
      cloudId:    { set: !!e.JIRA_CLOUD_ID,    secret: false, value:   e.JIRA_CLOUD_ID    || null },
      projectKey: { set: !!e.JIRA_PROJECT_KEY, secret: false, value:   e.JIRA_PROJECT_KEY || null },
    },
    claude: {
      apiKey: { set: !!e.ANTHROPIC_API_KEY, secret: true, preview: e.ANTHROPIC_API_KEY ? maskSecret(e.ANTHROPIC_API_KEY) : null },
    },
    schedule: {
      timezone:       { set: !!e.TIMEZONE,        secret: false, value: e.TIMEZONE        || null },
      eodCheckTime:   { set: !!e.EOD_CHECK_TIME,  secret: false, value: e.EOD_CHECK_TIME  || null },
      reportDay:      { set: !!e.REPORT_DAY,      secret: false, value: e.REPORT_DAY      || null },
      reportTime:     { set: !!e.REPORT_TIME,     secret: false, value: e.REPORT_TIME     || null },
      managerSlackId: { set: !!e.MANAGER_SLACK_ID, secret: false, value: e.MANAGER_SLACK_ID || null },
    },
    team: {
      // Returns the parsed members array (non-secret) so the Team tab can pre-populate.
      count:         parsedTeam.length,
      members:       parsedTeam,
      isPlaceholder: teamIsPlaceholder,
      rawSet:        !!e.TEAM_MEMBERS,
      parseError:    teamParseError,   // true when TEAM_MEMBERS is set but unparseable
    },
  });
});

/**
 * POST /api/config/connections
 * Updates any non-secret env value in the runtime config (no restart needed).
 * Secrets (tokens, API keys) must still be changed in .env + restart.
 * Body: any subset of the non-secret fields below.
 */
router.post('/connections', (req, res) => {
  try {
    const {
      channelId, jiraEmail, jiraSiteUrl, jiraCloudId, projectKey,
      timezone, eodCheckTime, reportDay, reportTime, managerSlackId,
    } = req.body;

    // Propagate every provided value into runtime env + sprintConfig overrides
    const updates = {};
    if (channelId     != null) { process.env.SLACK_CHANNEL_ID   = channelId;     updates.channelId = channelId; }
    if (jiraEmail     != null) { process.env.JIRA_EMAIL          = jiraEmail;     updates.jiraEmail = jiraEmail; }
    if (jiraSiteUrl   != null) { process.env.JIRA_SITE_URL       = jiraSiteUrl;   updates.jiraSiteUrl = jiraSiteUrl; }
    if (jiraCloudId   != null) { process.env.JIRA_CLOUD_ID       = jiraCloudId;   updates.jiraCloudId = jiraCloudId; }
    if (projectKey    != null) { updates.projectKey    = projectKey; }
    if (timezone      != null) { updates.timezone      = timezone; }
    if (eodCheckTime  != null) { updates.eodCheckTime  = eodCheckTime; }
    if (reportDay     != null) { updates.reportDay     = reportDay; }
    if (reportTime    != null) { updates.reportTime    = reportTime; }
    if (managerSlackId != null){ updates.managerSlackId = managerSlackId; }

    // Batch all schedule + sprint-config overrides through sprintConfig
    if (Object.keys(updates).length) setSprintConfig(updates);

    res.json({ ok: true, updated: updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
