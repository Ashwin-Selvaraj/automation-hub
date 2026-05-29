'use strict';

const express = require('express');
const router = express.Router();
const { getSprintConfig, setSprintConfig, setTeamMembers } = require('../utils/sprintConfig');
const { getSprintWindow } = require('../utils/dateUtils');
const slackService = require('../services/slackService');
const jiraService = require('../services/jiraService');
const claudeService = require('../services/claudeService');

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

module.exports = router;
