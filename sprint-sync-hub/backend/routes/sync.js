'use strict';

const express = require('express');
const router = express.Router();
const { runHuddleSync } = require('../cron');
const activityLog = require('../services/activityLog');

/**
 * POST /api/sync/run
 * Manually triggers the huddle→jira sync for all recent unprocessed messages.
 */
router.post('/run', async (req, res) => {
  try {
    const result = await runHuddleSync();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] POST /api/sync/run error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/log
 * Returns recent activity log entries.
 */
router.get('/log', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const entries = activityLog.getEntries(limit);
  res.json({ entries });
});

module.exports = router;
