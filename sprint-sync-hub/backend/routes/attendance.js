'use strict';

/**
 * Attendance routes — mounted at /api/attendance in server.js.
 *
 * All reads go through attendanceService which tries:
 *   Zoho API → Zoho Webhook → Slack first message
 */

const express           = require('express');
const router            = express.Router();
const attendanceService = require('../services/attendanceService');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// ─── GET /api/attendance/today ────────────────────────────────────────────────
// Returns today's attendance using the best available data source.
// Response shape is backward-compatible with the old Zoho-only route.

router.get('/today', async (req, res) => {
  try {
    const data = await attendanceService.getTodayAttendance(ORG_ID());
    res.json(data);
  } catch (err) {
    console.error('[Attendance] GET /today error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/source ───────────────────────────────────────────────
// Shows which data source is currently active and the discovered endpoint.

router.get('/source', async (req, res) => {
  try {
    const endpoint  = await attendanceService.discoverZohoEndpoint();
    const { query } = require('../db');
    const cfg = await query(
      `SELECT config_key, config_value, updated_at
       FROM system_config WHERE organisation_id = $1`,
      [ORG_ID()]
    ).catch(() => ({ rows: [] }));

    res.json({
      zohoApiEndpoint: endpoint || null,
      zohoApiWorking:  !!endpoint,
      configCache:     cfg.rows,
      activeSources: [
        endpoint        ? '1. zoho_api (primary)'                    : null,
        '2. zoho_webhook (real-time if webhook is configured)',
        '3. slack_presence (always available — first message of day)',
      ].filter(Boolean),
      webhookSetupUrl: '/api/webhooks/zoho-attendance',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/attendance/refresh-source ─────────────────────────────────────
// Force re-probe of Zoho endpoints (clears cached discovery result).

router.post('/refresh-source', async (req, res) => {
  try {
    attendanceService.resetEndpointCache();
    const { query } = require('../db');
    await query(
      `DELETE FROM system_config
       WHERE organisation_id = $1 AND config_key = 'zoho_attendance_endpoint'`,
      [ORG_ID()]
    ).catch(() => {});
    const endpoint = await attendanceService.discoverZohoEndpoint();
    res.json({
      probeComplete:   true,
      zohoApiEndpoint: endpoint || null,
      zohoApiWorking:  !!endpoint,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/history?days=7 ──────────────────────────────────────

router.get('/history', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    const data = await attendanceService.getTeamAttendanceHistory(ORG_ID(), days);
    res.json({ days, records: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/member/:memberId?days=30 ─────────────────────────────

router.get('/member/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    const days     = Math.min(parseInt(req.query.days || '30', 10), 90);
    if (isNaN(memberId)) return res.status(400).json({ error: 'Invalid memberId' });
    const data = await attendanceService.getMemberAttendanceHistory(memberId, days);
    res.json({ memberId, days, records: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/late-today ───────────────────────────────────────────

router.get('/late-today', async (req, res) => {
  try {
    const data = await attendanceService.getTodayAttendance(ORG_ID());
    res.json({ configured: true, date: data.date, late: data.late, total: data.late.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
