'use strict';

/**
 * Attendance routes — mounted at /api/attendance in server.js.
 *
 * All reads go through attendanceService, which merges:
 *   Zoho Chat presence → Zoho Webhook (real-time, overrides presence) → Slack fallback
 */

const express           = require('express');
const router            = express.Router();
const attendanceService = require('../services/attendanceService');
const zohoService       = require('../services/zohoService');
const featureFlags      = require('../services/featureFlags');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

const DISABLED_RESPONSE = {
  configured: false,
  enabled:    false,
  date:       new Date().toISOString().split('T')[0],
  message:    'Zoho attendance is disabled. Enable it in Settings.',
  present:    [],
  absent:     [],
  late:       [],
  onLeave:    [],
  summary:    { total: 0, present: 0, absent: 0, late: 0 },
};

// ─── GET /api/attendance/today ────────────────────────────────────────────────

router.get('/today', async (req, res) => {
  try {
    const enabled = await featureFlags.isZohoAttendanceEnabled();
    if (!enabled) return res.json({ ...DISABLED_RESPONSE, date: new Date().toISOString().split('T')[0] });

    const data = await attendanceService.getTodayAttendance(ORG_ID());
    res.json(data);
  } catch (err) {
    console.error('[Attendance] /today failed:', err.message);
    res.status(500).json({
      error: err.message, configured: false,
      present: [], absent: [], onLeave: [], late: [],
      summary: { total: 0, present: 0, absent: 0 },
    });
  }
});

// ─── GET /api/zoho/presence ───────────────────────────────────────────────────

router.get('/zoho/presence', async (req, res) => {
  try {
    const enabled = await featureFlags.isZohoAttendanceEnabled();
    if (!enabled) return res.json({ enabled: false, message: 'Zoho attendance is disabled.', data: [] });

    const users = await zohoService.getAllUsersWithPresence();
    res.json({
      total:   users.length,
      present: users.filter(u => u.isPresent).length,
      offline: users.filter(u => !u.isPresent).length,
      members: users.map(u => ({
        name:       u.fullName,
        email:      u.email,
        iamuid:     u.iamuid,
        employeeId: u.employeeId,
        present:    u.isPresent,
        status:     u.presenceStatus,
        message:    u.statusMessage,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/source ───────────────────────────────────────────────
// Reports which data source(s) actually supplied today's attendance data.

router.get('/source', async (req, res) => {
  try {
    const data = await attendanceService.getTodayAttendance(ORG_ID());
    res.json({
      primarySource: data.source,
      sourceDetails: data.sourceDetails,
      activeSources: [
        '1. zoho_presence (Zoho Chat presence — online/offline, no check-in time)',
        '2. zoho_webhook (real-time check-in/out — overrides presence when configured)',
        '3. slack_presence (fallback — first Slack message of the day)',
      ],
      webhookSetupUrl: '/api/webhooks/zoho-attendance',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/attendance/history?days=7 ──────────────────────────────────────

router.get('/history', async (req, res) => {
  try {
    const enabled = await featureFlags.isZohoAttendanceEnabled();
    if (!enabled) return res.json({ enabled: false, message: 'Zoho attendance is disabled.', data: [] });

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
