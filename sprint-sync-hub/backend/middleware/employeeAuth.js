'use strict';

const crypto = require('crypto');
const authRepo = require('../repositories/employeeAuthRepository');
const { safeEqual } = require('./auth');
const { resolveCookiePolicy } = require('./cookiePolicy');
const { allowedOrigins } = require('../utils/allowedOrigins');

const SESSION_COOKIE = 'ah_employee_session';
const LOGIN_COOKIE = 'ah_slack_login';

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((out, entry) => {
    const index = entry.indexOf('=');
    if (index < 0) return out;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
    return out;
  }, {});
}

function cookieOptions(maxAgeSeconds) {
  // Read per call so a changed environment takes effect without a code change;
  // resolving is a few string operations.
  const policy = resolveCookiePolicy();
  const parts = [
    'Path=/',
    'HttpOnly',
    `SameSite=${policy.sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (policy.secure) parts.push('Secure');
  return parts.join('; ');
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAgeSeconds)}`);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

async function requireEmployeeSession(req, res, next) {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return res.status(401).json({ code: 'UNAUTHENTICATED', error: 'Sign in with Slack first.' });

    const session = await authRepo.findActiveSession(hashToken(token));
    if (!session) {
      clearCookie(res, SESSION_COOKIE);
      return res.status(401).json({ code: 'UNAUTHENTICATED', error: 'Your employee session has expired.' });
    }

    req.employee = {
      sessionId: session.id,
      memberId: session.member_id,
      organisationId: session.organisation_id,
      slackUserId: session.slack_user_id,
      slackTeamId: session.slack_team_id,
      name: session.name,
      email: session.email,
      csrfHash: session.csrf_hash,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * A browser that names an Origin must name one this deployment trusts.
 *
 * The CSRF token is the real defence. This is the second one, and it matters
 * more now that the session cookie can be SameSite=None and so travels on
 * requests started from other sites: CORS only stops a hostile page *reading*
 * the response, not the request being made. A request with no Origin header is
 * not a cross-site browser request, so it is left to the token.
 */
function originIsTrusted(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const normalised = String(origin).replace(/\/+$/, '');
  if (allowedOrigins().includes(normalised)) return true;
  // Same origin as this API (a page served by the API itself).
  return normalised === `${req.protocol}://${req.get('host')}`;
}

function requireEmployeeCsrf(req, res, next) {
  if (!originIsTrusted(req)) {
    return res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED', error: 'This request came from an origin that is not allowed.' });
  }
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || !req.employee?.csrfHash || !safeEqual(hashToken(csrf), req.employee.csrfHash)) {
    return res.status(403).json({ code: 'CSRF_FAILED', error: 'Invalid request token. Refresh and try again.' });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  LOGIN_COOKIE,
  randomToken,
  hashToken,
  parseCookies,
  setCookie,
  clearCookie,
  requireEmployeeSession,
  requireEmployeeCsrf,
  originIsTrusted,
};
