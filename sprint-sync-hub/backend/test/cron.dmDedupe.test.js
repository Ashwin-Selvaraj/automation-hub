'use strict';

/**
 * Guards the fix for the duplicate-DM class of bug.
 *
 * Deduplication used to live in a 500-entry in-memory array, so a restart — or
 * simply a busy channel evicting the record — let the huddle sync re-send a
 * no-match DM to someone who had already received one. It now claims a durable
 * key before sending, and these tests pin that behaviour:
 *
 *   - claim granted  → the DM goes out exactly once
 *   - claim refused  → nothing is sent
 *   - send throws    → the claim is released so a later run can retry
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const calls = { dms: [], claims: [], releases: [] };
let claimResult = true;
let sendShouldThrow = false;

function reset() {
  calls.dms = [];
  calls.claims = [];
  calls.releases = [];
  claimResult = true;
  sendShouldThrow = false;
}

stubModule('services/slackService', {
  getChannelMessages: async () => [
    { text: 'Spent the day on some research, nothing on the board yet', user: 'U1', ts: '1700000000.000100' },
  ],
  sendDM: async (userId, text) => {
    if (sendShouldThrow) throw new Error('slack is down');
    calls.dms.push({ userId, text });
  },
  postToChannel: async () => {},
});

stubModule('services/jiraService', {
  getSprintIssues:  async () => [{ key: 'QG-1', summary: 'Build login page', status: 'To Do' }],
  addComment:       async () => {},
  transitionIssue:  async () => {},
  getOverdueIssues: async () => [],
});

stubModule('services/claudeService', {
  parseMultiDateStandup: async () => null,
  // No Jira task matches this update at all — the no-match branch.
  matchHuddleToJira: async () => ({
    matched: false, confidence: 10, issueKey: null, matchType: 'no_match',
    reason: 'nothing on the board resembles this', suggestedStatus: null, commentText: null,
  }),
  draftNoMatchDM: async () => 'please update Jira',
});

stubModule('core/auditLog', {
  record:                () => Promise.resolve(),
  list:                  async () => [],
  userIdsWithEntrySince: async () => new Set(),
});

stubModule('core/idempotency', {
  claim: async (orgId, key) => {
    calls.claims.push(key);
    return claimResult;
  },
  release: async (orgId, key) => { calls.releases.push(key); },
});

stubModule('core/cursor', {
  getNumber: async (_org, _key, fallback) => fallback,
  set:       async () => {},
});

stubModule('services/performanceService', {
  syncMemberStandup: async () => ({ member: { id: 1, name: 'Alice' } }),
  shouldSendTaskDM:  async () => true,
  recordNoMatchDM:   async () => {},
});

stubModule('services/mismatchService', { handleMismatch: async () => ({}) });
stubModule('repositories/statsRepository', { upsertDailyStats: async () => {} });
stubModule('repositories/sprintRepository', { getActiveSprint: async () => ({ id: 10 }) });
stubModule('repositories/memberRepository', { findOrCreate: async () => ({ id: 1, name: 'Alice' }), findAll: async () => [] });
stubModule('repositories/taskRepository', { findBySprintAndAssignee: async () => [], findByJiraKey: async () => null });
stubModule('repositories/notificationRepository', { recordNotification: async () => {}, wasNotifiedRecently: async () => false });
stubModule('services/configService', {
  getSprintConfig: () => ({
    channelId: 'C1', projectKey: 'QG', sprintName: 'Sprint 1',
    teamMembers: [{ id: 'U1', name: 'Alice' }],
    timezone: 'Asia/Kolkata',
  }),
});
stubModule('db', {
  query: async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
    return { rows: [] };
  },
});

const { runHuddleSync } = require('../cron');

test('no-match DM is sent when the dedupe claim is granted', async () => {
  reset();
  await runHuddleSync();

  assert.equal(calls.dms.length, 1, 'expected exactly one DM');
  assert.equal(calls.dms[0].userId, 'U1');
  assert.ok(
    calls.claims.some((k) => k.startsWith('no-match-dm:U1:')),
    'expected a dated per-member claim key'
  );
});

test('no DM is sent when the claim is already held — a restart cannot re-send', async () => {
  reset();
  claimResult = false;

  await runHuddleSync();

  assert.equal(calls.dms.length, 0, 'a held claim must suppress the DM entirely');
});

test('a failed send releases the claim so a later run can retry', async () => {
  reset();
  sendShouldThrow = true;

  await runHuddleSync();

  assert.equal(calls.dms.length, 0);
  assert.ok(
    calls.releases.some((k) => k.startsWith('no-match-dm:U1:')),
    'claim must be released when the DM never actually went out'
  );
});
