'use strict';

const express      = require('express');
const router       = express.Router();
const briefService = require('../services/briefService');
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

module.exports = router;
