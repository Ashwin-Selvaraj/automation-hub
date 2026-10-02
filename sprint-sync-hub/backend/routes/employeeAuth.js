'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const authRepo = require('../repositories/employeeAuthRepository');
const memberRepo = require('../repositories/memberRepository');
const { getOrgId } = require('../core/orgContext');
const { safeEqual } = require('../middleware/auth');
const {
  SESSION_COOKIE,
  LOGIN_COOKIE,
  randomToken,
  hashToken,
  parseCookies,
  setCookie,
  clearCookie,
  requireEmployeeSession,
  requireEmployeeCsrf,
} = require('../middleware/employeeAuth');

const STATE_TTL_MINUTES = 10;

function frontendUrl(params = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/${params}`;
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Slack did not return a valid identity token');
  return decodeJwtPart(parts[1]);
}

async function validateIdentityToken(token, payload, nonce, clientId) {
  const parts = String(token).split('.');
  const header = decodeJwtPart(parts[0]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Slack identity token algorithm was invalid');
  const keysResponse = await axios.get('https://slack.com/openid/connect/keys', { timeout: 10_000 });
  const jwk = keysResponse.data?.keys?.find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('Slack identity signing key was not found');
  const validSignature = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url')
  );
  if (!validSignature) throw new Error('Slack identity token signature was invalid');

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== 'https://slack.com' || !audience.includes(clientId)) {
    throw new Error('Slack identity token issuer or audience was invalid');
  }
  if (!payload.exp || payload.exp * 1000 <= Date.now()) {
    throw new Error('Slack identity token expired');
  }
  if (!payload.nonce || payload.nonce !== nonce) {
    throw new Error('Slack identity nonce did not match');
  }
}

router.get('/start', async (req, res, next) => {
  try {
    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_OIDC_REDIRECT_URI;
    if (!clientId || !redirectUri || !process.env.SLACK_CLIENT_SECRET || !process.env.SLACK_TEAM_ID) {
      return res.status(503).json({
        code: 'AUTH_NOT_CONFIGURED',
        error: 'Employee Slack sign-in is not configured.',
      });
    }

    const state = randomToken();
    const nonce = randomToken();
    const browserToken = randomToken();
    await authRepo.createOAuthState({
      provider: 'slack',
      stateHash: hashToken(state),
      browserHash: hashToken(browserToken),
      nonce,
      expiresAt: new Date(Date.now() + STATE_TTL_MINUTES * 60_000),
    });
    setCookie(res, LOGIN_COOKIE, browserToken, STATE_TTL_MINUTES * 60);

    const authUrl = `https://slack.com/openid/connect/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'openid profile email',
      redirect_uri: redirectUri,
      state,
      nonce,
      team: process.env.SLACK_TEAM_ID,
    })}`;
    res.json({ authUrl });
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  const browserToken = parseCookies(req)[LOGIN_COOKIE];
  clearCookie(res, LOGIN_COOKIE);

  try {
    if (!state || !code || !browserToken) throw new Error('Missing OAuth callback data');
    const stored = await authRepo.consumeOAuthState('slack', hashToken(state));
    if (!stored || !stored.browser_hash || !safeEqual(stored.browser_hash, hashToken(browserToken))) {
      throw new Error('OAuth state was invalid, expired, or already used');
    }

    const tokenResponse = await axios.post(
      'https://slack.com/api/openid.connect.token',
      new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.SLACK_OIDC_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 }
    );
    if (!tokenResponse.data?.ok || !tokenResponse.data?.access_token) {
      throw new Error(`Slack token exchange failed: ${tokenResponse.data?.error || 'unknown_error'}`);
    }

    const payload = decodeJwtPayload(tokenResponse.data.id_token);
    await validateIdentityToken(tokenResponse.data.id_token, payload, stored.nonce, process.env.SLACK_CLIENT_ID);
    const userInfoResponse = await axios.get('https://slack.com/api/openid.connect.userInfo', {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      timeout: 15_000,
    });
    const info = userInfoResponse.data;
    const slackUserId = info?.['https://slack.com/user_id'] || info?.sub;
    const teamId = info?.['https://slack.com/team_id'];
    if (!info?.ok || !slackUserId || payload.sub !== info.sub ||
        !teamId || teamId !== process.env.SLACK_TEAM_ID) {
      throw new Error('Slack user is not in the configured workspace');
    }
    if (!info.email || info.email_verified !== true) {
      throw new Error('Slack must provide a verified email address');
    }

    const member = await memberRepo.findBySlackUserId(getOrgId(), slackUserId);
    if (!member) throw new Error('Your Slack account is not mapped to an active team member');

    const token = randomToken();
    const csrf = randomToken();
    const ttlHours = Math.max(1, parseInt(process.env.EMPLOYEE_SESSION_TTL_HOURS || '12', 10));
    await authRepo.createSession({
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrf),
      memberId: member.id,
      slackTeamId: teamId,
      email: String(info.email).toLowerCase(),
      expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
    });
    setCookie(res, SESSION_COOKIE, token, ttlHours * 3600);
    res.redirect(frontendUrl('?employee_auth=success'));
  } catch (err) {
    console.warn('[employee-auth] Slack callback failed:', err.message);
    res.redirect(frontendUrl('?employee_auth=failed'));
  }
});

router.get('/me', requireEmployeeSession, (req, res) => {
  const csrf = randomToken();
  // Rotate the CSRF secret each time identity is refreshed.
  require('../db').query(
    'UPDATE employee_sessions SET csrf_hash = $1 WHERE id = $2',
    [hashToken(csrf), req.employee.sessionId]
  ).then(() => {
    res.json({
      authenticated: true,
      employee: { name: req.employee.name, email: req.employee.email },
      csrfToken: csrf,
    });
  }).catch((err) => res.status(500).json({ error: 'Could not refresh employee session', code: 'SESSION_ERROR' }));
});

router.post('/logout', requireEmployeeSession, requireEmployeeCsrf, async (req, res, next) => {
  try {
    await authRepo.revokeSession(req.employee.sessionId);
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
