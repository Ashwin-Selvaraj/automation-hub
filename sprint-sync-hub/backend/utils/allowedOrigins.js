'use strict';

/**
 * Browser origins allowed to call this API with credentials. One list, used both
 * by CORS and by the employee routes' own Origin check, so the two cannot drift.
 */

const DEFAULT_ORIGINS = 'http://localhost:5173,http://localhost:5174';

function allowedOrigins(env = process.env) {
  return String(env.CORS_ORIGINS || DEFAULT_ORIGINS)
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

module.exports = { allowedOrigins };
