'use strict';

const express = require('express');
const router = express.Router();
const jiraService = require('../services/jiraService');
const { getSprintWindow } = require('../utils/dateUtils');
const { getSprintConfig } = require('../utils/sprintConfig');
const activityLog = require('../services/activityLog');

/**
 * GET /api/jira/issues
 * Returns Jira issues updated within the current sprint window.
 */
router.get('/issues', async (req, res) => {
  try {
    const cfg = getSprintConfig();
    const { startStr, endStr } = getSprintWindow();
    const issues = await jiraService.getSprintIssues(cfg.projectKey, startStr, endStr);
    res.json({ issues });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] GET /api/jira/issues error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jira/overdue
 * Returns all overdue Jira issues for the project.
 */
router.get('/overdue', async (req, res) => {
  try {
    const cfg = getSprintConfig();
    const issues = await jiraService.getOverdueIssues(cfg.projectKey);
    res.json({ issues });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] GET /api/jira/overdue error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/jira/comment
 * Posts a comment to a Jira issue.
 * Body: { issueKey, text }
 */
router.post('/comment', async (req, res) => {
  try {
    const { issueKey, text } = req.body;
    if (!issueKey || !text) {
      return res.status(400).json({ error: 'issueKey and text are required' });
    }
    await jiraService.addComment(issueKey, text);
    activityLog.addEntry({
      type: 'jira_comment',
      jiraKey: issueKey,
      action: 'Comment added via dashboard',
      success: true,
      details: text.substring(0, 100),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/jira/comment error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/jira/transition
 * Transitions a Jira issue to a new status.
 * Body: { issueKey, statusName }
 */
router.post('/transition', async (req, res) => {
  try {
    const { issueKey, statusName } = req.body;
    if (!issueKey || !statusName) {
      return res.status(400).json({ error: 'issueKey and statusName are required' });
    }
    await jiraService.transitionIssue(issueKey, statusName);
    activityLog.addEntry({
      type: 'jira_transition',
      jiraKey: issueKey,
      action: `Transitioned to "${statusName}" via dashboard`,
      success: true,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/jira/transition error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
