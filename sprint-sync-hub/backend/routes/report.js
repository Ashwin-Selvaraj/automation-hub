'use strict';

const express = require('express');
const router = express.Router();
const claudeService = require('../services/claudeService');
const slackService = require('../services/slackService');
const jiraService = require('../services/jiraService');
const { getSprintWindow, getSprintWeeks, toUnixTimestamp, getWorkingDaysSince } = require('../utils/dateUtils');
const { getSprintConfig } = require('../utils/sprintConfig');
const activityLog = require('../services/activityLog');
const memberRoleRepository = require('../repositories/memberRoleRepository');

function orgId() {
  return parseInt(process.env.ORGANISATION_ID || '1', 10);
}

/**
 * Builds member activity data from Slack messages for a given time window.
 * @param {Array} messages - Raw Slack messages
 * @param {Array} teamMembers - Team member config
 * @param {number} workingDays - Total working days in the period
 * @returns {Array}
 */
function buildMemberActivity(messages, teamMembers, workingDays) {
  const byUser = {};
  for (const m of teamMembers) {
    byUser[m.id] = { name: m.name, updateCount: 0, workingDays, updates: [] };
  }
  for (const msg of messages) {
    if (byUser[msg.user]) {
      byUser[msg.user].updateCount++;
      if (msg.text) byUser[msg.user].updates.push(msg.text.substring(0, 120));
    }
  }
  return Object.values(byUser);
}

/**
 * POST /api/report/generate
 * Generates a sprint/week report using Claude AI.
 * Body: { weekIndex: 0 for full sprint, 1+ for specific week }
 */
router.post('/generate', async (req, res) => {
  try {
    const cfg = getSprintConfig();
    const weekIndex = parseInt(req.body.weekIndex || '0', 10);
    const weeks = getSprintWeeks();
    const { start: sprintStart, end: sprintEnd, startStr, endStr } = getSprintWindow();

    let windowStart, windowEnd, weekLabel;
    if (weekIndex === 0) {
      windowStart = sprintStart;
      windowEnd = sprintEnd;
      weekLabel = 'Full Sprint';
    } else {
      const week = weeks[weekIndex - 1];
      if (!week) return res.status(400).json({ error: `Week ${weekIndex} does not exist in this sprint` });
      windowStart = week.start;
      windowEnd = week.end;
      weekLabel = week.label;
    }

    const oldest = windowStart.getTime() / 1000;
    const latest = Math.min(windowEnd.getTime() / 1000, Date.now() / 1000);
    const workingDays = getWorkingDaysSince(windowStart.toISOString().split('T')[0]);

    const [rawMessages, jiraTasks, managerialKeys] = await Promise.all([
      slackService.getChannelMessages(cfg.channelId, oldest, latest),
      jiraService.getSprintIssues(cfg.projectKey, startStr, endStr),
      memberRoleRepository.getManagerialMemberKeys(orgId()),
    ]);

    // This app tracks IC activity/performance only — exclude managerial members.
    const trackedMembers = cfg.teamMembers.filter((m) => !managerialKeys.slackUserIds.has(m.id));
    const memberActivity = buildMemberActivity(rawMessages, trackedMembers, workingDays);
    const reportText = await claudeService.generateWeeklyReport(weekLabel, memberActivity, jiraTasks, cfg.sprintName);

    activityLog.addEntry({
      type: 'report_generated',
      action: `${weekLabel} report generated`,
      success: true,
    });

    res.json({ ok: true, report: reportText, weekLabel, memberActivity });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/report/generate error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/report/post
 * Posts the provided report text to the Slack standup channel.
 * Body: { report }
 */
router.post('/post', async (req, res) => {
  try {
    const { report } = req.body;
    if (!report) return res.status(400).json({ error: 'report text is required' });

    const cfg = getSprintConfig();
    await slackService.postToChannel(cfg.channelId, report);

    if (cfg.managerSlackId) {
      await slackService.sendDM(cfg.managerSlackId, report);
    }

    activityLog.addEntry({
      type: 'report_posted',
      action: 'Report posted to Slack channel',
      success: true,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/report/post error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
