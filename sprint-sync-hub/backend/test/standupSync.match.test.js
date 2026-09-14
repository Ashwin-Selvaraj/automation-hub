'use strict';

/**
 * Integration test for the standup-sync automation's happy path: a Slack
 * standup message that matches the member's own assigned Jira task should get
 * a comment posted and a status transition on that issue.
 *
 * All external services (Slack, Jira, Claude, DB, repositories) are stubbed
 * via require.cache substitution — this exercises cron.js's real control
 * flow (matching, DB member resolution, DM gating) without needing a live
 * Postgres/Slack/Jira/Anthropic connection.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const jiraCalls = { comments: [], transitions: [] };

stubModule('services/slackService', {
  getChannelMessages: async () => [
    { text: 'Finished the login page, deployed to staging', user: 'U1', ts: '1700000000.000100' },
  ],
  sendDM:        async () => {},
  postToChannel: async () => {},
});

stubModule('services/jiraService', {
  getSprintIssues:  async () => [{ key: 'QG-1', summary: 'Build login page', status: 'To Do' }],
  addComment:       async (issueKey, text)   => { jiraCalls.comments.push({ issueKey, text }); },
  transitionIssue:  async (issueKey, status) => { jiraCalls.transitions.push({ issueKey, status }); },
  getOverdueIssues: async () => [],
});

stubModule('services/claudeService', {
  parseMultiDateStandup: async () => null,
  matchHuddleToJira: async () => ({
    matched: true, confidence: 95, issueKey: 'QG-1', issueTitle: 'Build login page',
    suggestedStatus: 'In Progress', commentText: 'Login page work logged',
    reason: 'direct match', matchType: 'assigned_task', mismatchDetails: null,
  }),
  draftNoMatchDM:       async () => '',
  draftMissingUpdateDM: async () => '',
  draftDeadlineDM:      async () => '',
  draftMismatchDM:      async () => '',
  draftTeamLeadAlert:   async () => '',
  generateWeeklyReport: async () => '',
});

stubModule('core/auditLog', {
  record:                 () => Promise.resolve(),
  list:                   async () => [],
  listForUser:            async () => [],
  userIdsWithEntrySince:  async () => new Set(),
  purgeOlderThan:         async () => 0,
});

stubModule('core/idempotency', {
  claim:        async () => true,
  release:      async () => {},
  isClaimed:    async () => false,
  purgeExpired: async () => 0,
});

stubModule('core/cursor', {
  get:       async () => null,
  set:       async () => {},
  getNumber: async (_org, _key, fallback) => fallback,
  clear:     async () => {},
});

stubModule('services/performanceService', {
  syncMemberStandup:          async () => ({ member: { id: 1, name: 'Alice' } }),
  recordJiraSync:             async () => {},
  recordNoMatchDM:            async () => {},
  shouldSendTaskDM:           async () => true,
  runDailyDeadlineCheck:      async () => {},
  computeSprintSummary:       async () => {},
  getTeamLeaderboard:         async () => [],
  getAtRiskMembers:           async () => [],
});

stubModule('repositories/statsRepository', { upsertDailyStats: async () => {} });
stubModule('repositories/notificationRepository', {
  recordNotification:  async () => {},
  wasNotifiedRecently: async () => false,
});
stubModule('repositories/sprintRepository', {
  getActiveSprint: async () => ({ id: 10, name: 'Sprint 1' }),
  upsertSprint:    async () => {},
  setActive:       async () => {},
});
stubModule('repositories/memberRepository', {
  findOrCreate: async (orgId, slackId, name) => ({ id: 1, name }),
  findAll:      async () => [],
});
stubModule('services/configService', {
  getSprintConfig: () => ({
    channelId: 'C1', projectKey: 'QG', sprintName: 'Sprint 1',
    teamMembers: [{ id: 'U1', name: 'Alice', email: 'alice@example.com' }],
    timezone: 'Asia/Kolkata', syncTime: '10:00', eodCheckTime: '18:30',
    reportTime: '17:00', reportDay: 'Friday',
  }),
});
stubModule('services/attendanceService', {
  getTodayAttendance: async () => ({ members: [], sourceDetails: {} }),
});
stubModule('services/featureFlags', {
  isZohoAttendanceEnabled: async () => false,
  setFlag:                 async () => {},
  getFlag:                 async () => 'false',
  loadFlags:                async () => {},
});
stubModule('repositories/standupRepository', {
  findByMemberAndDate: async () => null,
});
stubModule('services/mismatchService', {
  handleMismatch: async () => ({ memberDmSent: false, leadAlertSent: false, recorded: false }),
});
stubModule('repositories/taskRepository', {
  findBySprintAndAssignee: async () => [{ jira_key: 'QG-1', title: 'Build login page', status: 'To Do' }],
  findByJiraKey:           async () => ({ id: 99, jira_key: 'QG-1' }),
});
stubModule('db', {
  query: async (sql) => {
    // The sync takes a Postgres advisory lock so a manual run and the cron
    // can't process the same messages at once.
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
    return { rows: [{ id: 99 }] };
  },
});

const standupSync = require('../automations/delivery/standupSync');
const configService = require('../services/configService');

const ctx = () => ({ orgId: 1, cfg: configService.getSprintConfig(), trigger: 'manual' });

test('standup-sync: matches a standup message to its assigned Jira task and updates it', async () => {
  const result = await standupSync.run(ctx());

  assert.equal(result.processed, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.noMatch, 0);
  assert.equal(result.errors, 0);

  assert.equal(jiraCalls.comments.length, 1);
  assert.equal(jiraCalls.comments[0].issueKey, 'QG-1');
  assert.equal(jiraCalls.comments[0].text, 'Login page work logged');

  assert.equal(jiraCalls.transitions.length, 1);
  assert.equal(jiraCalls.transitions[0].issueKey, 'QG-1');
  assert.equal(jiraCalls.transitions[0].status, 'In Progress');
});
