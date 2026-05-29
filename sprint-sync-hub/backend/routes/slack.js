'use strict';

const express = require('express');
const router = express.Router();
const slackService = require('../services/slackService');
const { getSprintWindow, toUnixTimestamp } = require('../utils/dateUtils');
const { getSprintConfig } = require('../utils/sprintConfig');
const activityLog = require('../services/activityLog');

/**
 * GET /api/slack/messages?days=7
 * Returns messages from the standup channel filtered to the sprint window.
 */
router.get('/messages', async (req, res) => {
  try {
    const cfg = getSprintConfig();
    const { start, end } = getSprintWindow();

    const daysBack = parseInt(req.query.days || '7', 10);
    const windowStart = new Date(Math.max(start.getTime(), Date.now() - daysBack * 86400 * 1000));
    const windowEnd = new Date(Math.min(end.getTime(), Date.now()));

    const oldest = windowStart.getTime() / 1000;
    const latest = windowEnd.getTime() / 1000;

    const raw = await slackService.getChannelMessages(cfg.channelId, oldest, latest);

    const messages = raw.map((m) => ({
      ts: m.ts,
      userId: m.user,
      text: m.text || '',
      date: new Date(parseFloat(m.ts) * 1000).toISOString(),
    }));

    res.json({ messages, sprintWindow: { start: start.toISOString(), end: end.toISOString() } });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] GET /api/slack/messages error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/slack/dm
 * Sends a direct message to a Slack user.
 * Body: { userId, message }
 */
router.post('/dm', async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }
    await slackService.sendDM(userId, message);
    activityLog.addEntry({
      type: 'manual_dm',
      userId,
      action: 'Manual DM sent via dashboard',
      success: true,
      details: message.substring(0, 100),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/slack/dm error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
