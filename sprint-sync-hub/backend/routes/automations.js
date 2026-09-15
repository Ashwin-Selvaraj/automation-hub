'use strict';

const express  = require('express');
const router   = express.Router();
const registry = require('../automations/registry');
const db       = require('../db');
const { getOrgId } = require('../core/orgContext');

/**
 * GET /api/automations
 * The catalogue: every automation, its schedule, whether it is on, and how its
 * last run went.
 */
router.get('/', async (req, res) => {
  try {
    res.json({ automations: await registry.list() });
  } catch (err) {
    console.error('[GET /api/automations]', err.message);
    res.status(500).json({ error: 'Could not load automations' });
  }
});

/**
 * PATCH /api/automations/:key
 * Body: { enabled?: boolean, schedule?: string|null }
 * Turning one off stops it immediately — no redeploy, no restart.
 */
router.patch('/:key', async (req, res) => {
  const { key } = req.params;
  const { enabled, schedule } = req.body || {};

  if (enabled === undefined && schedule === undefined) {
    return res.status(400).json({ error: 'Provide "enabled" or "schedule"' });
  }

  try {
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: '"enabled" must be true or false' });
      }
      await registry.setEnabled(key, enabled);
    }
    if (schedule !== undefined) {
      await registry.setSchedule(key, schedule);
    }
    const all = await registry.list();
    res.json({ automation: all.find((a) => a.key === key) });
  } catch (err) {
    if (/^Unknown automation/.test(err.message) ) return res.status(404).json({ error: err.message });
    if (/valid cron expression/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error(`[PATCH /api/automations/${key}]`, err.message);
    res.status(500).json({ error: 'Could not update the automation' });
  }
});

/**
 * POST /api/automations/:key/run
 * Runs one automation now. Its own deduplication still applies, so this cannot
 * be used to re-send a message that already went out today.
 */
router.post('/:key/run', async (req, res) => {
  const { key } = req.params;
  try {
    const outcome = await registry.runOne(key, 'manual');
    res.status(outcome.ok ? 200 : 500).json(outcome);
  } catch (err) {
    if (/^Unknown automation/.test(err.message)) return res.status(404).json({ error: err.message });
    console.error(`[POST /api/automations/${key}/run]`, err.message);
    res.status(500).json({ error: 'Could not run the automation' });
  }
});

/**
 * GET /api/automations/:key/runs
 * Recent run history for one automation.
 */
router.get('/:key/runs', async (req, res) => {
  const { key } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
  try {
    const { rows } = await db.query(
      `SELECT started_at, finished_at, status, trigger, duration_ms, summary, error
       FROM automation_runs
       WHERE organisation_id = $1 AND automation_key = $2
       ORDER BY started_at DESC LIMIT $3`,
      [getOrgId(), key, limit]
    );
    res.json({ runs: rows });
  } catch (err) {
    console.error(`[GET /api/automations/${key}/runs]`, err.message);
    res.status(500).json({ error: 'Could not load run history' });
  }
});

module.exports = router;
