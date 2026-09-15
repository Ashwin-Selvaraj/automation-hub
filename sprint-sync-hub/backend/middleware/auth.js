'use strict';

const crypto = require('crypto');

/**
 * Shared-secret API auth for /api routes.
 *
 * Without this, anyone who can reach the backend URL could rewrite
 * Slack/Jira/Anthropic credentials via /api/config/connections or trigger DMs
 * to real team members. Checks `x-api-key` (or `Authorization: Bearer <token>`)
 * against API_AUTH_TOKEN.
 *
 * Fails CLOSED. When API_AUTH_TOKEN is unset the API is refused entirely, with
 * one exception: a non-production process still serves loopback callers, so
 * `npm run dev` works with no setup while nothing reachable over a network is
 * ever left open.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

let warnedDevOpen = false;
let warnedNoToken = false;

function safeEqual(a, b) {
  // Hash first so differing lengths can't throw and can't leak length by timing.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoopback(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return LOOPBACK.has(ip);
}

function requireApiKey(req, res, next) {
  const expected = process.env.API_AUTH_TOKEN;

  if (!expected) {
    if (process.env.NODE_ENV !== 'production' && isLoopback(req)) {
      if (!warnedDevOpen) {
        console.warn('[auth] API_AUTH_TOKEN is not set — serving loopback requests only. Set it before exposing this process.');
        warnedDevOpen = true;
      }
      return next();
    }
    if (!warnedNoToken) {
      console.error('[auth] API_AUTH_TOKEN is not set — refusing all non-loopback API requests.');
      warnedNoToken = true;
    }
    return res.status(503).json({ error: 'Server is not configured for authenticated access' });
  }

  const bearer   = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = req.headers['x-api-key'] || bearer;

  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { requireApiKey, safeEqual };
