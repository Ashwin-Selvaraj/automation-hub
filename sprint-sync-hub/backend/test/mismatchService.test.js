'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

// ── Controllable fakes for every mismatchService dependency ─────────────────

const calls = { dmSent: [], leadAlerts: [], recorded: 0 };
function resetCalls() { calls.dmSent = []; calls.leadAlerts = []; calls.recorded = 0; }

let wasNotifiedRecentlyReturn = false;
let memberRolesReturn         = null; // null => "no roles yet" (canReceiveDM defaults true)

stubModule('repositories/notificationRepository', {
  wasNotifiedRecently: async () => wasNotifiedRecentlyReturn,
  recordNotification:  async () => {},
});
stubModule('repositories/taskRepository', {
  findBySprintAndAssignee: async () => [],
});
stubModule('repositories/memberRoleRepository', {
  getMemberWithRoles: async () => memberRolesReturn,
});
stubModule('services/claudeService', {
  draftMismatchDM:    async () => 'member dm text',
  draftTeamLeadAlert: async () => 'lead alert text',
});
stubModule('services/slackService', {
  sendDM: async (userId, text) => {
    if (text === 'member dm text') calls.dmSent.push(userId);
    else calls.leadAlerts.push(userId);
  },
});
stubModule('services/activityLog', {
  addEntry: () => {},
});
stubModule('db', {
  query: async () => { calls.recorded++; return { rows: [] }; },
});

const mismatchService = require('../services/mismatchService');

const MEMBER = { id: 5, name: 'Alice', slack_user_id: 'U1', email: 'a@x.com' };

test('handleMismatch: idempotency — skips everything if already notified in the last 4h', async () => {
  resetCalls();
  wasNotifiedRecentlyReturn = true;
  memberRolesReturn = null;

  const result = await mismatchService.handleMismatch(
    1, 10, MEMBER, 'working on something else',
    { matchType: 'unassigned_task', mismatchDetails: 'wrong task' }
  );

  assert.deepEqual(result, { memberDmSent: false, leadAlertSent: false, recorded: false });
  assert.equal(calls.dmSent.length, 0);
  assert.equal(calls.leadAlerts.length, 0);
  assert.equal(calls.recorded, 0);
});

test('handleMismatch: sends member DM + lead alert on a fresh mismatch', async () => {
  resetCalls();
  wasNotifiedRecentlyReturn = false;
  memberRolesReturn = null;
  process.env.TEAM_LEAD_SLACK_ID = 'ULEAD';

  const result = await mismatchService.handleMismatch(
    1, 10, MEMBER, 'working on something else',
    { matchType: 'unassigned_task', mismatchDetails: 'wrong task' }
  );

  assert.equal(result.memberDmSent, true);
  assert.equal(result.leadAlertSent, true);
  assert.equal(result.recorded, true);
  assert.deepEqual(calls.dmSent, ['U1']);
  assert.deepEqual(calls.leadAlerts, ['ULEAD']);
});

test('handleMismatch: managerial-only members are exempt from the member DM but the lead is still alerted', async () => {
  resetCalls();
  wasNotifiedRecentlyReturn = false;
  memberRolesReturn = { roles: [{ name: 'Manager' }], shouldReceiveTaskDms: false };
  process.env.TEAM_LEAD_SLACK_ID = 'ULEAD';

  const result = await mismatchService.handleMismatch(
    1, 10, MEMBER, 'working on something else',
    { matchType: 'unassigned_task', mismatchDetails: 'wrong task' }
  );

  assert.equal(result.memberDmSent, false);
  assert.equal(result.leadAlertSent, true);
  assert.deepEqual(calls.dmSent, []);
});

test('handleMismatch: no_match events never send a member DM directly, only alert the lead', async () => {
  resetCalls();
  wasNotifiedRecentlyReturn = false;
  memberRolesReturn = null;
  process.env.TEAM_LEAD_SLACK_ID = 'ULEAD';

  const result = await mismatchService.handleMismatch(
    1, 10, MEMBER, 'text',
    { matchType: 'no_match', mismatchDetails: 'no task found' }
  );

  assert.equal(result.memberDmSent, false);
  assert.equal(result.leadAlertSent, true);
});
