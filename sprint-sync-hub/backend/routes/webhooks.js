'use strict';

/**
 * Webhook routes — mounted at /api/webhooks in server.js.
 *
 * POST /api/webhooks/zoho-attendance
 *   Receives real-time check-in/check-out events pushed by Zoho People.
 *   Always returns HTTP 200 — if we return any other status, Zoho retries
 *   for hours and floods the logs.
 *
 * HOW TO CONFIGURE IN ZOHO PEOPLE (one-time setup, 3 minutes):
 *   1. Log in as Administrator
 *   2. Settings → Integrations → Webhooks
 *   3. Click "Add Webhook"
 *   4. Name:   Sprint-Sync Hub — Check In
 *      Event:  Attendance → Check In
 *      URL:    https://<your-backend>/api/webhooks/zoho-attendance
 *      Method: POST
 *      Format: JSON
 *   5. Save, then repeat for "Check Out" event
 *   6. Test by checking in on the Zoho People mobile app
 *      Logs will show: [Webhook] ✓ Name: checkIn at HH:MM
 */

const express           = require('express');
const router            = express.Router();
const attendanceService = require('../services/attendanceService');

// ─── POST /api/webhooks/zoho-attendance ───────────────────────────────────────

router.post('/zoho-attendance', async (req, res) => {
  // Always respond 200 immediately — Zoho retries indefinitely on non-200
  res.status(200).json({ received: true });

  // Process asynchronously after responding
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    console.warn('[Webhook] Received empty or non-JSON payload');
    return;
  }

  console.log('[Webhook] Zoho attendance event received:', JSON.stringify(payload).substring(0, 300));
  attendanceService.processZohoWebhook(payload)
    .then(result => console.log('[Webhook] Processed:', JSON.stringify(result)))
    .catch(err   => console.error('[Webhook] Processing error:', err.message));
});

// ─── GET /api/webhooks/zoho-attendance ────────────────────────────────────────
// Some Zoho integrations send a GET to verify the endpoint is reachable.

router.get('/zoho-attendance', (req, res) => {
  res.json({
    status:  'ready',
    message: 'Zoho attendance webhook endpoint is active',
    accepts: ['POST'],
  });
});

module.exports = router;
