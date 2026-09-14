'use strict';

/**
 * The inversion, pinned.
 *
 * When a standup matches no Jira task, the member must not be messaged. That
 * used to send a DM telling them their update didn't count, which taught people
 * to write for the matcher rather than for the team. The fact is now recorded
 * and surfaced to the lead in the daily brief instead.
 *
 * These tests fail loudly if a person-facing DM is ever reintroduced here.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const calls = { notifierSends: [], rawSlackDMs: [], claims: [], mismatches: [], audit: [] };

function reset() {
  calls.notifierSends = [];
  calls.rawSlackDMs = [];
  calls.claims = [];
  calls.mismatches = [];
  calls.audit = [];
}

stubModule('services/slackService', {
  getChannelMessages: async () => [
    { text: 'Spent the day on research, nothing on the board yet', user: 'U1', ts: '1700000000.000100' },
  ],
  sendDM: async (userId, text) => { calls.rawSlackDMs.push({ userId, text }); },
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
  // Present so that calling it would succeed — the point is that it is not called.
  draftNoMatchDM: async () => 'please update Jira',
});

stubModule('core/notifier', {
  sendDM: async (opts) => { calls.notifierSends.push(opts); return { sent: true }; },
  postToChannel: async () => ({ sent: true }),
});

stubModule('core/auditLog', {
  record: (orgId, entry) => { calls.audit.push(entry); return Promise.resolve(); },
  list: async () => [],
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

stubModule('services/mismatchService', {
  handleMismatch: async (orgId, sprintId, member, text, analysis) => {
    calls.mismatches.push({ name: member.name, matchType: analysis.matchType });
    return {};
  },
});

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

test('an unmatched standup sends the member nothing at all', async () => {
  reset();
  await standupSync.run(ctx());

  assert.deepEqual(calls.notifierSends, [], 'no DM may be sent to the member');
  assert.deepEqual(calls.rawSlackDMs, [], 'and nothing may bypass the notifier either');
});

test('the unmatched standup is still counted and recorded', async () => {
  reset();
  const result = await standupSync.run(ctx());

  assert.equal(result.noMatch, 1, 'the message is still counted as unmatched');
  assert.equal(result.errors, 0);

  assert.ok(
    calls.audit.some((e) => e.type === 'no_match' && e.userName === 'Alice'),
    'the fact must be written to the audit trail so the brief can surface it'
  );
});

test('the mismatch event is recorded once per person per day, not once per run', async () => {
  reset();
  await standupSync.run(ctx());

  assert.ok(
    calls.claims.some((k) => /^no-match-lead:U1:\d{4}-\d{2}-\d{2}$/.test(k)),
    'expected a dated claim so repeated syncs do not re-record the same day'
  );
  assert.equal(calls.mismatches.length, 1);
  assert.equal(calls.mismatches[0].matchType, 'no_match');
});
