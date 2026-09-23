'use strict';

const axios = require('axios');
const { encrypt, decrypt } = require('./cryptoService');
const connectionRepo = require('../repositories/zohoConnectionRepository');
const authRepo = require('../repositories/employeeAuthRepository');
const { randomToken, hashToken } = require('../middleware/employeeAuth');

const PROFILE_SCOPE = 'AaaServer.profile.Read';
const ACCOUNT_HOSTS = new Set([
  'accounts.zoho.com',
  'accounts.zoho.in',
  'accounts.zoho.eu',
  'accounts.zoho.com.au',
  'accounts.zoho.jp',
  'accounts.zoho.ca',
  'accounts.zoho.sa',
]);

function normalizeAccountsServer(value) {
  const fallback = process.env.ZOHO_ACCOUNTS_SERVER || 'https://accounts.zoho.com';
  const parsed = new URL(value || fallback);
  if (parsed.protocol !== 'https:' || !ACCOUNT_HOSTS.has(parsed.hostname) || parsed.pathname !== '/') {
    throw new Error('Unsupported Zoho Accounts server');
  }
  return parsed.origin;
}

function config() {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = process.env.ZOHO_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error('Employee Zoho OAuth is not configured');
    err.code = 'ZOHO_NOT_CONFIGURED';
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

function tokenLifetimeSeconds(token) {
  const value = Number(token.expires_in_sec || token.expires_in || 3600);
  return value > 86_400 ? Math.floor(value / 1000) : value;
}

async function createAuthorizationUrl(employee) {
  const cfg = config();
  const state = randomToken();
  const accountsServer = normalizeAccountsServer();
  await authRepo.createOAuthState({
    provider: 'zoho',
    stateHash: hashToken(state),
    employeeSessionId: employee.sessionId,
    metadata: { accountsServer },
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const authUrl = `${accountsServer}/oauth/v2/auth?${new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    scope: PROFILE_SCOPE,
    redirect_uri: cfg.redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;
  return authUrl;
}

async function exchangeCallback({ code, state, location, callbackAccountsServer }) {
  if (!code || !state) {
    const err = new Error('Missing Zoho OAuth callback data');
    err.code = 'OAUTH_INVALID';
    throw err;
  }
  const stored = await authRepo.consumeOAuthState('zoho', hashToken(state));
  if (!stored?.employee_session_id) {
    const err = new Error('Zoho OAuth state was invalid, expired, or already used');
    err.code = 'OAUTH_STATE_INVALID';
    throw err;
  }

  const cfg = config();
  const accountsServer = normalizeAccountsServer(
    callbackAccountsServer || stored.metadata?.accountsServer
  );
  const tokenResponse = await axios.post(`${accountsServer}/oauth/v2/token`, null, {
    params: {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    },
    timeout: 15_000,
  });
  const token = tokenResponse.data || {};
  if (token.error || !token.access_token || !token.refresh_token) {
    const err = new Error('Zoho did not issue the required tokens');
    err.code = token.error || 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  const sessionResult = await require('../db').query(
    `SELECT s.*, m.organisation_id, m.name
       FROM employee_sessions s
       JOIN members m ON m.id = s.member_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [stored.employee_session_id]
  );
  const session = sessionResult.rows[0];
  if (!session) {
    const err = new Error('Employee session expired during Zoho connection');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  const userInfoResponse = await axios.get(`${accountsServer}/oauth/user/info`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
    timeout: 15_000,
  });
  const info = userInfoResponse.data || {};
  const zohoEmail = String(info.Email || info.email || '').trim().toLowerCase();
  const zohoUserId = String(info.ZUID || info.zuid || info.User_ID || '').trim() || null;
  if (!zohoEmail || zohoEmail !== String(session.email).toLowerCase()) {
    const err = new Error('Zoho account email does not match your verified Slack email');
    err.code = 'IDENTITY_MISMATCH';
    throw err;
  }

  const expiresIn = tokenLifetimeSeconds(token);
  await connectionRepo.upsert(session.member_id, {
    accessTokenEncrypted: encrypt(token.access_token),
    refreshTokenEncrypted: encrypt(token.refresh_token),
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    zohoUserId,
    zohoEmail,
    location: location || null,
    accountsServer,
    apiDomain: token.api_domain || null,
    grantedScopes: token.scope || PROFILE_SCOPE,
  });
  return { memberId: session.member_id };
}

async function ensureConnected(memberId) {
  let connection = await connectionRepo.findByMemberId(memberId);
  if (!connection) return { connected: false, status: 'not_connected' };
  if (connection.status === 'revoked') {
    return { connected: false, status: 'revoked', reconnectRequired: true };
  }
  if (connection.access_token_encrypted &&
      connection.access_token_expires_at &&
      new Date(connection.access_token_expires_at).getTime() > Date.now() + 60_000) {
    return { connected: true, status: 'connected', email: connection.zoho_email };
  }

  try {
    const cfg = config();
    const response = await axios.post(`${normalizeAccountsServer(connection.accounts_server)}/oauth/v2/token`, null, {
      params: {
        refresh_token: decrypt(connection.refresh_token_encrypted),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'refresh_token',
      },
      timeout: 15_000,
    });
    if (response.data?.error || !response.data?.access_token) {
      const error = response.data?.error || 'refresh_failed';
      if (error === 'invalid_code' || error === 'invalid_grant') {
        await connectionRepo.markRevoked(memberId, error);
        return { connected: false, status: 'revoked', reconnectRequired: true };
      }
      throw new Error(error);
    }
    const expiresIn = tokenLifetimeSeconds(response.data);
    connection = await connectionRepo.updateAccessToken(
      memberId,
      encrypt(response.data.access_token),
      new Date(Date.now() + expiresIn * 1000),
      response.data.api_domain
    );
    return { connected: true, status: 'connected', email: connection.zoho_email };
  } catch (err) {
    const providerCode = err.response?.data?.error || err.message;
    if (providerCode === 'invalid_code' || providerCode === 'invalid_grant') {
      await connectionRepo.markRevoked(memberId, providerCode);
      return { connected: false, status: 'revoked', reconnectRequired: true };
    }
    const wrapped = new Error('Zoho connection could not be verified');
    wrapped.code = 'ZOHO_ERROR';
    throw wrapped;
  }
}

async function disconnect(memberId) {
  await connectionRepo.remove(memberId);
}

module.exports = {
  PROFILE_SCOPE,
  createAuthorizationUrl,
  exchangeCallback,
  ensureConnected,
  disconnect,
  normalizeAccountsServer,
};
