'use strict';

const express = require('express');
const router = express.Router();
const { runHuddleSync } = require('../cron');
const activityLog = require('../services/activityLog');
const memberRoleRepository = require('../repositories/memberRoleRepository');

function orgId() {
  return parseInt(process.env.ORGANISATION_ID || '1', 10);
}

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
 * Returns recent activity log entries. Excludes managerial members — this app
 * tracks IC activity/performance only. Log entries record `userId`
 * inconsistently (sometimes a Slack ID, sometimes a DB member id depending on
 * the code path that logged them), so filtering is done by `userName` instead,
 * which every call site sets consistently.
 */
router.get('/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const { names: managerialNames } = await memberRoleRepository.getManagerialMemberKeys(orgId());
    const entries = activityLog.getEntries(500)
      .filter((e) => !managerialNames.has(e.userName))
      .slice(0, limit);
    res.json({ entries });
  } catch (err) {
    console.error('[GET /api/sync/log]', err.message);
    res.json({ entries: activityLog.getEntries(parseInt(req.query.limit || '50', 10)) });
  }
});

module.exports = router;
