'use strict';

/**
 * Shared-secret API auth for /api routes.
 *
 * CORS is wide open by design (dashboard is hosted separately from the API),
 * which means without this, anyone who can reach the backend URL could
 * rewrite Slack/Jira/Anthropic credentials via /api/config/connections or
 * trigger DMs to real team members. Checks the `x-api-key` header (or
 * `Authorization: Bearer <token>`) against API_AUTH_TOKEN.
 *
 * If API_AUTH_TOKEN is not set, requests are allowed through with a one-time
 * boot warning — matches the ENCRYPTION_KEY dev-fallback pattern already
 * used elsewhere in this codebase, so local dev keeps working with zero setup.
 */

let warned = false;

function requireApiKey(req, res, next) {
  const expected = process.env.API_AUTH_TOKEN;

  if (!expected) {
    if (!warned) {
      console.warn('[auth] API_AUTH_TOKEN is not set — all /api routes are UNPROTECTED. Set API_AUTH_TOKEN in .env before deploying anywhere reachable from the internet.');
      warned = true;
    }
    return next();
  }

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = req.headers['x-api-key'] || bearer;

  if (provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { requireApiKey };
