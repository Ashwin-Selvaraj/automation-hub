'use strict';

/**
 * The standup-sync automation must never send a person-facing DM without
 * handing the notifier a dedupe key, and must respect the notifier's answer.
 *
 * Deduplication used to live in a 500-entry in-memory array, so a restart — or
 * simply a busy channel evicting the record — let the sync re-send a no-match
 * DM to someone who had already received one. Sending now goes through
 * core/notifier, which refuses any send that arrives without a key.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const calls = { sends: [], claims: [] };
let notifierResult = { sent: true };

function reset() {
  calls.sends = [];
  calls.claims = [];
  notifierResult = { sent: true };
}

stubModule('services/slackService', {
  getChannelMessages: async () => [
    { text: 'Spent the day on research, nothing on the board yet', user: 'U1', ts: '1700000000.000100' },
  ],
  sendDM: async () => { throw new Error('standup-sync must not call slackService directly'); },
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
  matchHuddleToJira: async () => ({
    matched: false, confidence: 10, issueKey: null, matchType: 'no_match',
    reason: 'nothing on the board resembles this', suggestedStatus: null, commentText: null,
  }),
  draftNoMatchDM: async () => 'please update Jira',
});

stubModule('core/notifier', {
  sendDM: async (opts) => { calls.sends.push(opts); return notifierResult; },
  postToChannel: async () => ({ sent: true }),
});

stubModule('core/auditLog', {
  record:                () => Promise.resolve(),
  list:                  async () => [],
  userIdsWithEntrySince: async () => new Set(),
});

stubModule('core/idempotency', {
  claim: async (orgId, key) => { calls.claims.push(key); return true; },
  release: async () => {},
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
stubModule('db', {
  query: async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
    return { rows: [] };
  },
});

const standupSync = require('../automations/delivery/standupSync');

const CFG = {
  channelId: 'C1', projectKey: 'QG', sprintName: 'Sprint 1',
  teamMembers: [{ id: 'U1', name: 'Alice' }],
  timezone: 'Asia/Kolkata',
};
const ctx = () => ({ orgId: 1, cfg: CFG, trigger: 'manual' });

test('a no-match DM is always sent with a dated, per-person dedupe key', async () => {
  reset();
  await standupSync.run(ctx());

  assert.equal(calls.sends.length, 1, 'expected exactly one DM attempt');
  const send = calls.sends[0];
  assert.equal(send.slackUserId, 'U1');
  assert.match(send.dedupeKey, /^no-match-dm:U1:\d{4}-\d{2}-\d{2}$/);
  assert.equal(send.type, 'no_match_dm');
});

test('the sync keeps running when the notifier reports the DM was already sent', async () => {
  reset();
  notifierResult = { sent: false, reason: 'already sent' };

  const result = await standupSync.run(ctx());

  assert.equal(result.noMatch, 1, 'the message is still counted');
  assert.equal(result.errors, 0, 'a suppressed DM is not an error');
});

test('the lead alert is claimed once per person per day, separately from the DM', async () => {
  reset();
  await standupSync.run(ctx());

  assert.ok(
    calls.claims.some((k) => /^no-match-lead:U1:\d{4}-\d{2}-\d{2}$/.test(k)),
    'expected a dated lead-alert claim so the lead is not re-alerted on every run'
  );
});
