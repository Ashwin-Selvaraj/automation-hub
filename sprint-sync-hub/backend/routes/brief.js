'use strict';

const express      = require('express');
const router       = express.Router();
const briefService = require('../services/briefService');
const deliveryRiskService = require('../services/deliveryRiskService');
const { getOrgId } = require('../core/orgContext');

/**
 * GET /api/brief/today
 *
 * Returns the brief as both structured signals and rendered text, without
 * sending anything. Lets the dashboard show today's brief on demand and makes
 * the automation's output reviewable before it goes out.
 *
 * ?date=YYYY-MM-DD  look at a different day
 * ?focus=false      skip the model call that writes the lead-in line
 */
router.get('/today', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : undefined;
    const withFocus = req.query.focus !== 'false';

    const signals = await briefService.collect(getOrgId(), { date, withFocus });
    res.json({ signals, text: briefService.render(signals) });
  } catch (err) {
    console.error('[GET /api/brief/today]', err.message);
    res.status(500).json({ error: 'Could not build the brief' });
  }
});

/**
 * GET /api/brief/risk
 *
 * Delivery risk on its own: the throughput forecast, who is holding too much
 * started work, and what was added after the sprint began. The same assessment
 * the brief carries, for a dashboard that wants to show it separately.
 */
router.get('/risk', async (req, res) => {
  try {
    const wipLimit = parseInt(req.query.wipLimit || '', 10);
    const risk = await deliveryRiskService.assess(getOrgId(), {
      wipLimit: Number.isInteger(wipLimit) && wipLimit > 0 ? wipLimit : undefined,
    });
    if (!risk) return res.status(404).json({ error: 'No active sprint to assess' });
    res.json(risk);
  } catch (err) {
    console.error('[GET /api/brief/risk]', err.message);
    res.status(500).json({ error: 'Could not assess delivery risk' });
  }
});

module.exports = router;
