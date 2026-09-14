'use strict';

/**
 * Webhook routes — mounted at /api/webhooks in server.js, ahead of the API-key
 * middleware because Zoho cannot attach custom headers to its callbacks.
 *
 * Authentication is therefore a secret path segment: the caller must present
 * ZOHO_WEBHOOK_SECRET as the last part of the URL. Without that secret set,
 * the endpoint refuses everything rather than accepting unauthenticated writes
 * into attendance_records.
 *
 * POST /api/webhooks/zoho-attendance/<ZOHO_WEBHOOK_SECRET>
 *   Receives real-time check-in/check-out events pushed by Zoho People.
 *   Returns HTTP 200 on every authenticated call — any other status makes Zoho
 *   retry for hours and flood the logs.
 *
 * HOW TO CONFIGURE IN ZOHO PEOPLE (one-time setup):
 *   1. Log in as Administrator
 *   2. Settings → Integrations → Webhooks → Add Webhook
 *   3. Name:   Sprint-Sync Hub — Check In
 *      Event:  Attendance → Check In
 *      URL:    https://<your-backend>/api/webhooks/zoho-attendance/<secret>
 *      Method: POST
 *      Format: JSON
 *   4. Save, then repeat for the "Check Out" event
 *   5. Test by checking in on the Zoho People mobile app
 *      Logs will show: [Webhook] ✓ Name: checkIn at HH:MM
 */

const express           = require('express');
const router            = express.Router();
const attendanceService = require('../services/attendanceService');
const { safeEqual }     = require('../middleware/auth');

let warnedNoSecret = false;

function verifyWebhookSecret(req, res, next) {
  const expected = process.env.ZOHO_WEBHOOK_SECRET;

  if (!expected) {
    if (!warnedNoSecret) {
      console.error('[Webhook] ZOHO_WEBHOOK_SECRET is not set — rejecting all webhook calls. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
      warnedNoSecret = true;
    }
    return res.status(503).json({ error: 'Webhook endpoint is not configured' });
  }

  if (!req.params.secret || !safeEqual(req.params.secret, expected)) {
    console.warn(`[Webhook] Rejected call with bad secret from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ─── POST /api/webhooks/zoho-attendance/:secret ───────────────────────────────

router.post('/zoho-attendance/:secret', verifyWebhookSecret, async (req, res) => {
  // Respond 200 immediately — Zoho retries indefinitely on non-200.
  res.status(200).json({ received: true });

  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn('[Webhook] Received empty or non-object payload');
    return;
  }

  console.log('[Webhook] Zoho attendance event received:', JSON.stringify(payload).substring(0, 300));
  attendanceService.processZohoWebhook(payload)
    .then((result) => console.log('[Webhook] Processed:', JSON.stringify(result)))
    .catch((err)   => console.error('[Webhook] Processing error:', err.message));
});

// ─── GET /api/webhooks/zoho-attendance/:secret ────────────────────────────────
// Some Zoho integrations send a GET to verify the endpoint is reachable.

router.get('/zoho-attendance/:secret', verifyWebhookSecret, (req, res) => {
  res.json({
    status:  'ready',
    message: 'Zoho attendance webhook endpoint is active',
    accepts: ['POST'],
  });
});

module.exports = router;
