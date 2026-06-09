'use strict';

const express      = require('express');
const router       = express.Router();
const featureFlags = require('../services/featureFlags');

// ─── GET /api/settings/zoho-attendance ───────────────────────────────────────

router.get('/zoho-attendance', async (req, res) => {
  try {
    const enabled = await featureFlags.isZohoAttendanceEnabled();
    res.json({
      feature:     'zoho_attendance',
      enabled,
      description: 'Controls whether Zoho attendance data is fetched and displayed',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/settings/zoho-attendance ─────────────────────────────────────

router.patch('/zoho-attendance', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }
    await featureFlags.setFlag('zoho_attendance_enabled', String(enabled));
    console.log(`[Settings] Zoho attendance ${enabled ? 'ENABLED' : 'DISABLED'}`);
    res.json({
      feature: 'zoho_attendance',
      enabled,
      message: `Zoho attendance ${enabled ? 'enabled' : 'disabled'} successfully`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
