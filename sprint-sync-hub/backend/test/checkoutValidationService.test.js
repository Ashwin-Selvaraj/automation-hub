'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

let messages = [];
let storedPost = null;
let zohoStatus = { connected: true, status: 'connected' };
let slackError = null;
let slackCalls = 0;

stubModule('services/slackService', {
  async getChannelMessages() {
    slackCalls++;
    if (slackError) throw slackError;
    return messages;
  },
});
stubModule('repositories/standupRepository', {
  async findByMemberAndDate() { return storedPost; },
});
stubModule('services/employeeZohoService', {
  async ensureConnected() { return zohoStatus; },
});

const service = require('../services/checkoutValidationService');

process.env.TIMEZONE = 'Asia/Kolkata';
process.env.SLACK_CHANNEL_ID = 'C123';
process.env.ZOHO_CHECKOUT_URL = 'https://people.zoho.in/acme/attendance';
delete process.env.SLACK_CHANNEL_URL;

const employee = { memberId: 7, slackUserId: 'U_ASHWIN' };
const now = new Date('2026-09-23T12:00:00.000Z');
const ownTs = String(new Date('2026-09-23T06:30:00.000Z').getTime() / 1000);

test.beforeEach(() => {
  messages = [];
  storedPost = null;
  zohoStatus = { connected: true, status: 'connected' };
  slackError = null;
  slackCalls = 0;
});

test('returns NOT_CONNECTED before checking Slack', async () => {
  zohoStatus = { connected: false, status: 'not_connected' };
  const result = await service.validate(employee, now);
  assert.equal(result.code, 'NOT_CONNECTED');
  assert.equal(slackCalls, 0);
});

test('finds only the signed-in employee current-day update', async () => {
  messages = [
    { user: 'U_OTHER', text: 'another employee update', ts: ownTs },
    { user: 'U_ASHWIN', text: 'my daily update', ts: ownTs },
  ];
  const result = await service.validate(employee, now);
  assert.equal(result.code, 'UPDATE_FOUND');
  assert.match(result.checkoutUrl, /^https:\/\/people\.zoho\.in/);
});

test('another employee, previous day, and thread reply do not count', async () => {
  messages = [
    { user: 'U_OTHER', text: 'update', ts: ownTs },
    { user: 'U_ASHWIN', text: 'reply only', ts: ownTs, thread_ts: '999.1' },
  ];
  const result = await service.validate(employee, now);
  assert.equal(result.code, 'UPDATE_MISSING');
  assert.match(result.slackChannelUrl, /C123/);

  messages = [{ user: 'U_ASHWIN', text: 'yesterday', ts: String(Number(ownTs) - 86400) }];
  const second = await service.validate(employee, now);
  assert.equal(second.code, 'UPDATE_MISSING');
});

test('rejects a cached previous-day post and checks Slack again', async () => {
  storedPost = {
    slack_message_ts: String(new Date('2026-09-22T06:30:00.000Z').getTime() / 1000),
  };
  const result = await service.validate(employee, now);
  assert.equal(result.code, 'UPDATE_MISSING');
  assert.equal(slackCalls, 1);
});

test('uses a valid cached same-day standup without a Slack API call', async () => {
  storedPost = { slack_message_ts: ownTs };
  const result = await service.validate(employee, now);
  assert.equal(result.code, 'UPDATE_FOUND');
  assert.equal(slackCalls, 0);
});

test('distinguishes Slack API failure from a missing update', async () => {
  slackError = new Error('ratelimited');
  await assert.rejects(
    () => service.validate(employee, now),
    (err) => err.code === 'SLACK_ERROR' && err.message === 'Slack could not be checked right now'
  );
});

test('does not expose or call any attendance-write capability', () => {
  assert.deepEqual(
    Object.keys(service).sort(),
    ['checkoutDestination', 'currentDayWindow', 'slackChannelUrl', 'validate']
  );
  assert.equal(service.checkoutDestination(), 'https://people.zoho.in/acme/attendance');
});
