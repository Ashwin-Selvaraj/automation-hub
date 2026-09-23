'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

let stateRecord;
let connection;
let upserted;
let removedMember;
let postResponse;
let userInfo;
let sessionRow;

const fakeAxios = {
  async post() { return { data: postResponse }; },
  async get() { return { data: userInfo }; },
};

stubModule('node_modules/axios/dist/node/axios.cjs', fakeAxios);
stubModule('services/cryptoService', {
  encrypt: (value) => `encrypted:${value}`,
  decrypt: (value) => String(value).replace(/^encrypted:/, ''),
});
stubModule('repositories/employeeAuthRepository', {
  async createOAuthState(value) { stateRecord = value; return value; },
  async consumeOAuthState() {
    const value = stateRecord;
    stateRecord = null;
    return value;
  },
});
stubModule('repositories/zohoConnectionRepository', {
  async findByMemberId() { return connection; },
  async upsert(memberId, value) { upserted = { memberId, ...value }; return upserted; },
  async updateAccessToken(memberId, accessTokenEncrypted, expiresAt, apiDomain) {
    return { ...connection, member_id: memberId, access_token_encrypted: accessTokenEncrypted, access_token_expires_at: expiresAt, api_domain: apiDomain };
  },
  async markRevoked(memberId, code) {
    connection = { ...connection, member_id: memberId, status: 'revoked', last_error_code: code };
  },
  async remove(memberId) { removedMember = memberId; },
});
stubModule('middleware/employeeAuth', {
  randomToken: () => 'random-token',
  hashToken: (value) => `hash:${value}`,
});
stubModule('db', {
  async query() { return { rows: sessionRow ? [sessionRow] : [] }; },
});

const service = require('../services/employeeZohoService');

process.env.ZOHO_CLIENT_ID = 'client';
process.env.ZOHO_CLIENT_SECRET = 'secret';
process.env.ZOHO_OAUTH_REDIRECT_URI = 'https://hub.example/api/employee/zoho/callback';
process.env.ZOHO_ACCOUNTS_SERVER = 'https://accounts.zoho.com';

test.beforeEach(() => {
  stateRecord = null;
  connection = null;
  upserted = null;
  removedMember = null;
  postResponse = {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    api_domain: 'https://www.zohoapis.com',
  };
  userInfo = { Email: 'employee@example.com', ZUID: '12345' };
  sessionRow = { id: 10, member_id: 42, email: 'employee@example.com' };
});

test('creates session-bound, profile-only OAuth state', async () => {
  const url = await service.createAuthorizationUrl({ sessionId: 10 });
  assert.match(url, /scope=AaaServer\.profile\.Read/);
  assert.doesNotMatch(url, /attendance/i);
  assert.equal(stateRecord.employeeSessionId, 10);
});

test('rejects mismatched and replayed OAuth state', async () => {
  stateRecord = null;
  await assert.rejects(
    () => service.exchangeCallback({ code: 'code', state: 'wrong' }),
    (err) => err.code === 'OAUTH_STATE_INVALID'
  );

  stateRecord = { employee_session_id: 10, metadata: { accountsServer: 'https://accounts.zoho.com' } };
  await service.exchangeCallback({ code: 'code', state: 'valid' });
  await assert.rejects(
    () => service.exchangeCallback({ code: 'code', state: 'valid' }),
    (err) => err.code === 'OAUTH_STATE_INVALID'
  );
});

test('binds the Zoho account to the member from the stored session', async () => {
  stateRecord = { employee_session_id: 10, metadata: { accountsServer: 'https://accounts.zoho.com' } };
  await service.exchangeCallback({ code: 'code', state: 'valid', location: 'us' });
  assert.equal(upserted.memberId, 42);
  assert.equal(upserted.zohoEmail, 'employee@example.com');
  assert.equal(upserted.refreshTokenEncrypted, 'encrypted:refresh');
});

test('rejects a Zoho account belonging to a different employee', async () => {
  userInfo = { Email: 'other@example.com', ZUID: '999' };
  stateRecord = { employee_session_id: 10, metadata: { accountsServer: 'https://accounts.zoho.com' } };
  await assert.rejects(
    () => service.exchangeCallback({ code: 'code', state: 'valid' }),
    (err) => err.code === 'IDENTITY_MISMATCH'
  );
  assert.equal(upserted, null);
});

test('reports a revoked token and supports disconnect without exposing it', async () => {
  connection = { member_id: 42, status: 'revoked', refresh_token_encrypted: 'encrypted:secret' };
  assert.deepEqual(
    await service.ensureConnected(42),
    { connected: false, status: 'revoked', reconnectRequired: true }
  );
  await service.disconnect(42);
  assert.equal(removedMember, 42);
});

test('refreshes an expired employee connection', async () => {
  connection = {
    member_id: 42,
    status: 'connected',
    zoho_email: 'employee@example.com',
    accounts_server: 'https://accounts.zoho.com',
    refresh_token_encrypted: 'encrypted:refresh',
    access_token_expires_at: new Date(0),
  };
  postResponse = { access_token: 'new-access', expires_in: 3600, api_domain: 'https://www.zohoapis.com' };
  const status = await service.ensureConnected(42);
  assert.equal(status.connected, true);
  assert.equal(status.email, 'employee@example.com');
});

test('marks an expired connection revoked when Zoho rejects its refresh token', async () => {
  connection = {
    member_id: 42,
    status: 'connected',
    zoho_email: 'employee@example.com',
    accounts_server: 'https://accounts.zoho.com',
    refresh_token_encrypted: 'encrypted:refresh',
    access_token_expires_at: new Date(0),
  };
  postResponse = { error: 'invalid_grant' };
  const status = await service.ensureConnected(42);
  assert.deepEqual(status, { connected: false, status: 'revoked', reconnectRequired: true });
  assert.equal(connection.last_error_code, 'invalid_grant');
});
