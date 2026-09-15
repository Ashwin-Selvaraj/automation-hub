'use strict';

const express = require('express');
const router = express.Router();
const registry = require('../automations/registry');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const { getOrgId } = require('../core/orgContext');
const auditLog = require('../core/auditLog');

/**
 * POST /api/sync/run
 * Manually triggers the huddle→jira sync for all recent unprocessed messages.
 */
router.post('/run', async (req, res) => {
  const outcome = await registry.runOne('standup-sync', 'manual');
  if (!outcome.ok) {
    console.error('[POST /api/sync/run]', outcome.error);
    return res.status(500).json({ error: outcome.error });
  }
  res.json({ ok: true, ...(outcome.result || {}) });
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
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  try {
    const { names: managerialNames } = await memberRoleRepository.getManagerialMemberKeys(getOrgId());
    const entries = (await auditLog.list(getOrgId(), 500))
      .filter((e) => !managerialNames.has(e.userName))
      .slice(0, limit);
    res.json({ entries });
  } catch (err) {
    console.error('[GET /api/sync/log]', err.message);
    res.status(500).json({ error: 'Could not load the activity log' });
  }
});

module.exports = router;
