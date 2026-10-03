'use strict';

/**
 * Employee sign-in cookies. The dashboard and the API are normally different
 * hosts; whether the browser will send and accept a cookie between them depends
 * on whether those hosts are the same *site*. These tests pin the decision and
 * the headers that result — the behaviour was confirmed separately in a real
 * browser, where the old always-Lax cookies failed on a split-host deployment
 * with "Missing OAuth callback data" and then a permanent 401.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

stubModule('db', { query: async () => ({ rows: [] }) });
let session = null;
stubModule('repositories/employeeAuthRepository', {
  createOAuthState: async () => {},
  findActiveSession: async () => session,
});

const { resolveCookiePolicy, sameSite, siteOf } = require('../middleware/cookiePolicy');
const employeeAuth = require('../middleware/employeeAuth');

const ENV_KEYS = ['NODE_ENV', 'FRONTEND_URL', 'SLACK_OIDC_REDIRECT_URI', 'EMPLOYEE_COOKIE_SAMESITE', 'CORS_ORIGINS',
  'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_TEAM_ID'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
test.afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  session = null;
});

const policy = (env) => resolveCookiePolicy({ NODE_ENV: 'production', ...env });

// ─── Which hosts are the same site ────────────────────────────────────────────

test('sites are registrable domains, so shared hosting domains are not one site', () => {
  assert.equal(siteOf('app.example.com'), 'example.com');
  assert.equal(siteOf('a.b.example.com'), 'example.com');
  assert.equal(siteOf('a.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('dash.vercel.app'), 'dash.vercel.app', 'every *.vercel.app is a different customer');
  assert.equal(siteOf('hub.up.railway.app'), 'hub.up.railway.app');
  assert.equal(siteOf('localhost'), 'localhost');
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');

  assert.equal(sameSite('https://app.example.com', 'https://api.example.com/x'), true);
  assert.equal(sameSite('https://a.vercel.app', 'https://b.vercel.app'), false);
  assert.equal(sameSite('https://dash.vercel.app', 'https://hub.up.railway.app'), false);
  assert.equal(sameSite('http://localhost:5173', 'http://localhost:3001'), true, 'ports do not make a request cross-site');
  assert.equal(sameSite('http://localhost:5173', 'http://127.0.0.1:3001'), false);
  assert.equal(sameSite('not a url', 'https://example.com'), null);
});

// ─── The policy ───────────────────────────────────────────────────────────────

test('one domain for dashboard and API keeps the stricter Lax cookie', () => {
  const p = policy({ FRONTEND_URL: 'https://app.example.com', SLACK_OIDC_REDIRECT_URI: 'https://api.example.com/api/auth/slack/callback' });
  assert.equal(p.sameSite, 'Lax');
  assert.equal(p.secure, true);
  assert.deepEqual(p.warnings, []);
});

test('a split-host deployment gets SameSite=None; Secure, and is told its limits', () => {
  const p = policy({ FRONTEND_URL: 'https://dash.vercel.app', SLACK_OIDC_REDIRECT_URI: 'https://hub.up.railway.app/api/auth/slack/callback' });
  assert.equal(p.sameSite, 'None');
  assert.equal(p.secure, true);
  assert.ok(p.warnings.some((w) => /Safari/.test(w) && /one domain/.test(w)), 'says why one domain is better');
});

test('local development stays Lax and not Secure, so plain http works', () => {
  const p = policy({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:5173', SLACK_OIDC_REDIRECT_URI: 'http://localhost:3001/cb' });
  assert.equal(p.sameSite, 'Lax');
  assert.equal(p.secure, false);
});

test('nothing configured is the local default, not a guess', () => {
  const p = policy({ NODE_ENV: 'development' });
  assert.equal(p.sameSite, 'Lax');
  assert.equal(p.crossSite, false);
});

test('SameSite=None is always Secure, even outside production — browsers reject it otherwise', () => {
  const p = policy({ NODE_ENV: 'development', EMPLOYEE_COOKIE_SAMESITE: 'none' });
  assert.equal(p.sameSite, 'None');
  assert.equal(p.secure, true);
});

test('forcing Lax on a split deployment is allowed but warns that sign-in will fail', () => {
  const p = policy({ EMPLOYEE_COOKIE_SAMESITE: 'LAX', FRONTEND_URL: 'https://a.vercel.app', SLACK_OIDC_REDIRECT_URI: 'https://b.railway.app/cb' });
  assert.equal(p.sameSite, 'Lax');
  assert.ok(p.warnings.some((w) => /will fail/.test(w)));
});

test('an unusable setting stops the boot instead of being ignored', () => {
  assert.throws(() => policy({ EMPLOYEE_COOKIE_SAMESITE: 'strict' }), /must be "lax" or "none"/);
  assert.throws(() => policy({ EMPLOYEE_COOKIE_SAMESITE: 'nnone' }), /must be "lax" or "none"/);
});

// ─── The headers actually issued ──────────────────────────────────────────────

function appWithStart() {
  const router = require('../routes/employeeAuth');
  const app = express();
  app.use('/api/auth/slack', router);
  return app;
}

function setCookieHeader(res) {
  return [].concat(res.headers['set-cookie'] || []).join('\n');
}

test('sign-in sets the login cookie with the policy’s attributes', async () => {
  Object.assign(process.env, {
    NODE_ENV: 'production', SLACK_CLIENT_ID: 'c', SLACK_CLIENT_SECRET: 's', SLACK_TEAM_ID: 'T',
    FRONTEND_URL: 'https://dash.vercel.app', SLACK_OIDC_REDIRECT_URI: 'https://hub.up.railway.app/api/auth/slack/callback',
  });
  const res = await request(appWithStart()).get('/api/auth/slack/start').expect(200);
  const cookie = setCookieHeader(res);
  assert.match(cookie, /ah_slack_login=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);

  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.SLACK_OIDC_REDIRECT_URI = 'https://api.example.com/api/auth/slack/callback';
  const same = setCookieHeader(await request(appWithStart()).get('/api/auth/slack/start').expect(200));
  assert.match(same, /SameSite=Lax/);
  assert.match(same, /HttpOnly/);
  assert.ok(!/SameSite=None/.test(same));
});

test('clearing a cookie uses the same attributes, or a SameSite=None cookie would not be cleared', () => {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://dash.vercel.app', SLACK_OIDC_REDIRECT_URI: 'https://hub.up.railway.app/cb',
  });
  const headers = [];
  employeeAuth.clearCookie({ append: (name, value) => headers.push([name, value]) }, 'ah_employee_session');
  assert.match(headers[0][1], /Max-Age=0/);
  assert.match(headers[0][1], /SameSite=None; |SameSite=None$/);
  assert.match(headers[0][1], /Secure/);
});

// ─── Origin check ─────────────────────────────────────────────────────────────

function csrfApp() {
  const app = express();
  app.use((req, res, next) => {
    req.employee = { csrfHash: employeeAuth.hashToken('good-token') };
    next();
  });
  app.post('/act', employeeAuth.requireEmployeeCsrf, (req, res) => res.json({ ok: true }));
  return app;
}

test('a state-changing request from an origin that is not allowed is refused, even with a valid token', async () => {
  process.env.CORS_ORIGINS = 'https://dash.vercel.app,https://other.example.com/';
  const app = csrfApp();

  const evil = await request(app).post('/act').set('Origin', 'https://evil.example').set('X-CSRF-Token', 'good-token');
  assert.equal(evil.status, 403);
  assert.equal(evil.body.code, 'ORIGIN_NOT_ALLOWED');

  await request(app).post('/act').set('Origin', 'https://dash.vercel.app').set('X-CSRF-Token', 'good-token').expect(200);
  await request(app).post('/act').set('Origin', 'https://other.example.com').set('X-CSRF-Token', 'good-token').expect(200);
  // Prefix tricks do not match.
  await request(app).post('/act').set('Origin', 'https://dash.vercel.app.evil.example').set('X-CSRF-Token', 'good-token').expect(403);
});

test('the token is still required from an allowed origin', async () => {
  process.env.CORS_ORIGINS = 'https://dash.vercel.app';
  const app = csrfApp();
  const res = await request(app).post('/act').set('Origin', 'https://dash.vercel.app').set('X-CSRF-Token', 'wrong');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CSRF_FAILED');
});

test('a request with no Origin header is a non-browser caller and is left to the token', async () => {
  process.env.CORS_ORIGINS = 'https://dash.vercel.app';
  await request(csrfApp()).post('/act').set('X-CSRF-Token', 'good-token').expect(200);
  await request(csrfApp()).post('/act').expect(403);
});
