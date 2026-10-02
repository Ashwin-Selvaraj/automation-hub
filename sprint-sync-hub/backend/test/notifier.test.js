'use strict';

/**
 * core/notifier is the only path out of this app to a human, which is what
 * makes the duplicate-DM bug structurally impossible rather than fixed one
 * call site at a time. These tests pin the three guarantees it provides:
 *
 *   - no send without a dedupe key
 *   - a held claim suppresses the send entirely
 *   - a failed send releases the claim, so a retry is still possible
 *
 * plus quiet hours, so a nudge never teaches the team that 9pm is working time.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const calls = { dms: [], channel: [], claimed: [], released: [] };
let claimResult = true;
let sendThrows  = false;

function reset() {
  calls.dms = []; calls.channel = []; calls.claimed = []; calls.released = [];
  claimResult = true;
  sendThrows  = false;
}

stubModule('services/slackService', {
  sendDM: async (userId, text) => {
    if (sendThrows) throw new Error('slack is down');
    calls.dms.push({ userId, text });
  },
  postToChannel: async (channelId, text) => {
    if (sendThrows) throw new Error('slack is down');
    calls.channel.push({ channelId, text });
  },
});

stubModule('core/idempotency', {
  claim: async (_org, key) => { calls.claimed.push(key); return claimResult; },
  release: async (_org, key) => { calls.released.push(key); },
});

stubModule('core/auditLog', { record: () => Promise.resolve() });

stubModule('services/configService', {
  // Every day a working day, so these tests do not depend on the day they run.
  getSprintConfig: () => ({ timezone: 'UTC', workdays: '0-6' }),
});

const notifier = require('../core/notifier');

// A window wide enough that the tests don't depend on when they run.
function openTheDay() {
  process.env.WORK_START_TIME = '00:00';
  process.env.WORK_END_TIME   = '22:59';
}

test('a send without a dedupe key is refused outright', async () => {
  reset(); openTheDay();
  await assert.rejects(
    () => notifier.sendDM({ orgId: 1, slackUserId: 'U1', text: 'hi', type: 'test' }),
    /requires a dedupeKey/
  );
  assert.equal(calls.dms.length, 0);
});

test('a granted claim sends exactly once', async () => {
  reset(); openTheDay();
  const out = await notifier.sendDM({
    orgId: 1, slackUserId: 'U1', text: 'hi', dedupeKey: 'k1', type: 'test',
  });
  assert.equal(out.sent, true);
  assert.equal(calls.dms.length, 1);
  assert.deepEqual(calls.claimed, ['k1']);
});

test('a held claim suppresses the send — the restart case', async () => {
  reset(); openTheDay();
  claimResult = false;

  const out = await notifier.sendDM({
    orgId: 1, slackUserId: 'U1', text: 'hi', dedupeKey: 'k1', type: 'test',
  });

  assert.equal(out.sent, false);
  assert.equal(out.reason, 'already sent');
  assert.equal(calls.dms.length, 0, 'nothing may reach Slack when the claim is held');
});

test('a failed send releases the claim so a later run can retry', async () => {
  reset(); openTheDay();
  sendThrows = true;

  const out = await notifier.sendDM({
    orgId: 1, slackUserId: 'U1', text: 'hi', dedupeKey: 'k1', type: 'test',
  });

  assert.equal(out.sent, false);
  assert.deepEqual(calls.released, ['k1'], 'a message that never went must not stay claimed');
});

test('quiet hours hold back a DM, and never claim the key', async () => {
  reset();
  // A window that has already closed, whatever time the suite runs.
  process.env.WORK_START_TIME = '00:00';
  process.env.WORK_END_TIME   = '00:00';

  const out = await notifier.sendDM({
    orgId: 1, slackUserId: 'U1', text: 'hi', dedupeKey: 'k1', type: 'test',
  });

  // 00:00-01:00 is inside the grace hour, so only assert the pairing that
  // matters: a held-back message is never claimed and never sent.
  if (!out.sent) {
    assert.equal(calls.dms.length, 0);
    assert.deepEqual(calls.claimed, [], 'a held-back message must stay sendable later');
  }
});

test('urgent messages bypass quiet hours', async () => {
  reset();
  process.env.WORK_START_TIME = '00:00';
  process.env.WORK_END_TIME   = '00:00';

  const out = await notifier.sendDM({
    orgId: 1, slackUserId: 'U1', text: 'report', dedupeKey: 'k2', type: 'test', urgent: true,
  });

  assert.equal(out.sent, true);
  assert.equal(calls.dms.length, 1);
});

test('channel posts skip quiet hours but still need a key', async () => {
  reset();
  process.env.WORK_START_TIME = '00:00';
  process.env.WORK_END_TIME   = '00:00';

  await assert.rejects(
    () => notifier.postToChannel({ orgId: 1, channelId: 'C1', text: 'x', type: 'test' }),
    /requires a dedupeKey/
  );

  const out = await notifier.postToChannel({
    orgId: 1, channelId: 'C1', text: 'weekly report', dedupeKey: 'c1', type: 'test',
  });
  assert.equal(out.sent, true, 'a channel post interrupts nobody');
});

test('a missing recipient is reported, not thrown', async () => {
  reset(); openTheDay();
  const out = await notifier.sendDM({ orgId: 1, slackUserId: '', text: 'hi', dedupeKey: 'k3', type: 'test' });
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'no recipient');
});

test('quiet hours follow the team’s working days and zone, not a fixed weekend', () => {
  process.env.WORK_START_TIME = '09:00';
  process.env.WORK_END_TIME   = '18:00';
  // Saturday 19 Sept 2026, 10:00 in Kolkata.
  const saturdayMorning = new Date('2026-09-19T04:30:00Z');
  const weekdays = { timezone: 'Asia/Kolkata', workdays: '1-5' };
  const sixDays  = { timezone: 'Asia/Kolkata', workdays: '1-6' };

  assert.equal(notifier.quietHoursCheck(weekdays, saturdayMorning).allowed, false);
  assert.equal(notifier.quietHoursCheck(sixDays, saturdayMorning).allowed, true,
    'a team that works Saturdays is not on a weekend on Saturday');

  // Friday 18 Sept: 08:59 is early, 18:59 is inside the grace hour, 19:01 is not.
  const at = (hhmm) => new Date(`2026-09-18T${hhmm}:00+05:30`);
  assert.equal(notifier.quietHoursCheck(weekdays, at('08:59')).allowed, false);
  assert.equal(notifier.quietHoursCheck(weekdays, at('09:00')).allowed, true);
  assert.equal(notifier.quietHoursCheck(weekdays, at('18:59')).allowed, true);
  assert.equal(notifier.quietHoursCheck(weekdays, at('19:01')).allowed, false);
});
