'use strict';

const crypto = require('crypto');
const authRepo = require('../repositories/employeeAuthRepository');
const { safeEqual } = require('./auth');

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
  const parts = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
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

function requireEmployeeCsrf(req, res, next) {
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
};
