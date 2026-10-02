'use strict';

/**
 * The past-due digest. What it replaced sent one DM per task per day for as long
 * as a task stayed overdue, then a "critically overdue" DM after three days, then
 * a DM to the manager that the lead never saw. The tests are mostly about those
 * things no longer being possible.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
process.env.JIRA_SITE_URL = 'https://acme.atlassian.net';

const s = {
  sprint: { id: 5 }, rows: [], jiraIssues: [], members: [],
  managerial: new Set(), sends: [], sendResult: { sent: true },
  claims: new Set(), released: [], history: [], bookkeeping: 0,
};

stubModule('services/jiraService', { getOverdueIssues: async () => s.jiraIssues });
stubModule('services/performanceService', {
  shouldSendTaskDM: async (id) => !s.managerial.has(id),
  recordDeadlineMisses: async () => { s.bookkeeping++; },
});
stubModule('repositories/taskRepository', { getOverdueTasks: async () => s.rows });
stubModule('repositories/memberRepository', { findAll: async () => s.members });
stubModule('repositories/sprintRepository', { getActiveSprint: async () => s.sprint });
stubModule('repositories/notificationRepository', {
  recordNotification: async (org, member, type, channel, ref) => { s.history.push({ member, type, ref }); },
});
stubModule('core/notifier', { sendDM: async (o) => { s.sends.push(o); return s.sendResult; } });
stubModule('core/idempotency', {
  claim: async (org, key) => { if (s.claims.has(key)) return false; s.claims.add(key); return true; },
  release: async (org, key) => { s.released.push(key); s.claims.delete(key); },
});

const check = require('../automations/delivery/deadlineCheck');

const CFG = { timezone: 'Asia/Kolkata', projectKey: 'QG', managerSlackId: 'UMANAGER' };

function reset() {
  Object.assign(s, {
    sprint: { id: 5 }, rows: [], jiraIssues: [], members: [], managerial: new Set(),
    sends: [], sendResult: { sent: true }, claims: new Set(), released: [], history: [], bookkeeping: 0,
  });
}

// DATE values arrive as local-midnight Dates; build them the way pg does.
const dueDaysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

const row = (over = {}) => ({
  id: 1, jira_key: 'QG-1', title: 'Payment flow', due_date: dueDaysAgo(3),
  assignee_id: 1, assignee_name: 'Bob Stone', slack_user_id: 'UBOB', ...over,
});

// ─── The wording ─────────────────────────────────────────────────────────────

test('weeks are keyed by their Monday', () => {
  assert.equal(check.weekStart('2026-09-14'), '2026-09-14', 'a Monday is its own week');
  assert.equal(check.weekStart('2026-09-16'), '2026-09-14', 'Wednesday');
  assert.equal(check.weekStart('2026-09-20'), '2026-09-14', 'Sunday belongs to the week before');
  assert.equal(check.weekStart('2026-09-21'), '2026-09-21');
  assert.equal(check.weekStart('2026-01-01'), '2025-12-29', 'across a year boundary');
});

test('days past due are whole calendar days', () => {
  assert.equal(check.daysPast('2026-09-11', '2026-09-14'), 3);
  assert.equal(check.daysPast('2026-09-13', '2026-09-14'), 1);
  assert.equal(check.daysPast('2026-02-27', '2026-03-02'), 3, 'across a month end');
});

test('the digest lists each task as a link with its due date, and says a moved date is enough', () => {
  const text = check.buildDigest({
    name: 'Bob Stone', today: '2026-09-14',
    tasks: [
      { taskKey: 'QG-12', title: 'Payment flow', dueDate: '2026-09-11' },
      { taskKey: 'QG-15', title: 'Search',       dueDate: '2026-09-13' },
    ],
  });
  assert.match(text, /^Hi Bob 👋 2 tasks have passed their due date:/);
  assert.ok(text.includes('<https://acme.atlassian.net/browse/QG-12|QG-12 Payment flow>'));
  assert.match(text, /due 11 Sep \(3 days ago\)/);
  assert.match(text, /due 13 Sep \(1 day ago\)/);
  assert.match(text, /updating it in Jira is enough/);
});

test('a single task reads grammatically, and a long list says how many more there are', () => {
  const one = check.buildDigest({ name: 'Bob', today: '2026-09-14', tasks: [{ taskKey: 'QG-1', title: 'T', dueDate: '2026-09-13' }] });
  assert.match(one, /1 task has passed its due date/);

  const many = check.buildDigest({ name: 'Bob', today: '2026-09-14', more: 4, tasks: [{ taskKey: 'QG-1', title: 'T', dueDate: '2026-09-13' }] });
  assert.match(many, /_…and 4 more_/);
});

test('the digest never reads as a telling-off or an escalation', () => {
  const text = check.buildDigest({
    name: 'Bob', today: '2026-09-30', tasks: [{ taskKey: 'QG-1', title: 'Old thing', dueDate: '2026-09-01' }],
  }).toLowerCase();
  for (const word of ['overdue', 'critical', 'immediately', 'urgent', 'escalat', 'must', 'should', 'failed', 'behind', 'slow', 'late ']) {
    assert.ok(!text.includes(word), `the digest must not contain "${word}"`);
  }
});

test('a hostile task title cannot mention people or forge a link', () => {
  const text = check.buildDigest({
    name: '<@U999>', today: '2026-09-14',
    tasks: [{ taskKey: 'QG-1', title: '<!channel> <https://evil.example|bank>', dueDate: '2026-09-13' }],
  });
  assert.ok(!text.includes('<!channel>'));
  assert.ok(!text.includes('<@U999>'));
  assert.ok(!text.includes('<https://evil.example'));
});

// ─── Running ─────────────────────────────────────────────────────────────────

test('a person with several overdue tasks gets ONE message, not one each', async () => {
  reset();
  s.rows = [row({ id: 1, jira_key: 'QG-1' }), row({ id: 2, jira_key: 'QG-2' }), row({ id: 3, jira_key: 'QG-3' })];
  const out = await check.run({ orgId: 1, cfg: CFG });

  assert.equal(s.sends.length, 1);
  assert.equal(out.sent, 1);
  assert.equal(out.tasksMentioned, 3);
  assert.equal((s.sends[0].text.match(/^• /gm) || []).length, 3, 'all three are in the one digest');
});

test('each person gets their own digest with a per-person, per-day dedupe key', async () => {
  reset();
  s.rows = [
    row({ id: 1, jira_key: 'QG-1' }),
    row({ id: 2, jira_key: 'QG-2', assignee_id: 2, assignee_name: 'Carol Ng', slack_user_id: 'UCAROL' }),
  ];
  await check.run({ orgId: 1, cfg: CFG });

  assert.deepEqual(s.sends.map((m) => m.slackUserId).sort(), ['UBOB', 'UCAROL']);
  assert.match(s.sends[0].dedupeKey, /^deadline-digest:\d+:\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.sends[0].type, 'deadline_dm');
});

test('a task a week or more overdue produces no second "critical" message and no manager message', async () => {
  reset();
  s.rows = [row({ due_date: dueDaysAgo(21) })];
  await check.run({ orgId: 1, cfg: CFG });

  assert.equal(s.sends.length, 1, 'one message, however overdue');
  assert.ok(!s.sends.some((m) => m.slackUserId === 'UMANAGER'), 'the manager is never messaged from here');
  assert.ok(!/critical|immediately|escalat/i.test(s.sends[0].text));
});

test('the same overdue tasks are not mentioned again later in the same week', async () => {
  reset();
  s.rows = [row({ id: 1, jira_key: 'QG-1' }), row({ id: 2, jira_key: 'QG-2' })];
  await check.run({ orgId: 1, cfg: CFG });
  assert.equal(s.sends.length, 1);

  // Next morning, same week: the per-day digest key is new, the weekly task claims are not.
  for (const k of [...s.claims]) if (k.startsWith('deadline-digest:')) s.claims.delete(k);
  const again = await check.run({ orgId: 1, cfg: CFG });

  assert.equal(s.sends.length, 1, 'no second message');
  assert.equal(again.alreadyToldThisWeek, 1);
});

test('a task that has only just become overdue is mentioned, and the older ones are not repeated', async () => {
  reset();
  s.rows = [row({ id: 1, jira_key: 'QG-1' })];
  await check.run({ orgId: 1, cfg: CFG });

  for (const k of [...s.claims]) if (k.startsWith('deadline-digest:')) s.claims.delete(k);
  s.rows = [row({ id: 1, jira_key: 'QG-1' }), row({ id: 2, jira_key: 'QG-NEW', due_date: dueDaysAgo(1) })];
  await check.run({ orgId: 1, cfg: CFG });

  assert.equal(s.sends.length, 2);
  assert.ok(s.sends[1].text.includes('QG-NEW'));
  assert.ok(!s.sends[1].text.includes('QG-1 '), 'the one already mentioned this week is not listed again');
});

test('the weekly claim is keyed to the task and the week, so it resets on Monday', async () => {
  reset();
  s.rows = [row({ jira_key: 'QG-12' })];
  await check.run({ orgId: 1, cfg: CFG });
  assert.ok([...s.claims].some((k) => /^deadline-task:QG-12:\d{4}-\d{2}-\d{2}$/.test(k)));
});

test('at most eight tasks are listed, only those are claimed, and the rest are counted', async () => {
  reset();
  s.rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, jira_key: `QG-${i + 1}`, due_date: dueDaysAgo(20 - i) }));
  const out = await check.run({ orgId: 1, cfg: CFG });

  assert.equal((s.sends[0].text.match(/^• /gm) || []).length, 8);
  assert.match(s.sends[0].text, /_…and 4 more_/);
  assert.equal(out.tasksMentioned, 8);
  assert.equal([...s.claims].filter((k) => k.startsWith('deadline-task:')).length, 8, 'the other four stay unclaimed for a later digest');
});

test('the oldest overdue tasks come first', async () => {
  reset();
  s.rows = [row({ id: 1, jira_key: 'QG-NEWER', due_date: dueDaysAgo(2) }), row({ id: 2, jira_key: 'QG-OLDER', due_date: dueDaysAgo(9) })];
  await check.run({ orgId: 1, cfg: CFG });
  const text = s.sends[0].text;
  assert.ok(text.indexOf('QG-OLDER') < text.indexOf('QG-NEWER'));
});

test('managerial-only members are not messaged about their own tasks', async () => {
  reset();
  s.rows = [row({ assignee_id: 9, assignee_name: 'Lead', slack_user_id: 'ULEAD' })];
  s.managerial.add(9);
  const out = await check.run({ orgId: 1, cfg: CFG });
  assert.equal(s.sends.length, 0);
  assert.equal(out.skippedManagerial, 1);
});

test('someone with no Slack account is skipped and counted', async () => {
  reset();
  s.rows = [row({ slack_user_id: null })];
  const out = await check.run({ orgId: 1, cfg: CFG });
  assert.equal(s.sends.length, 0);
  assert.equal(out.skippedNoSlack, 1);
});

test('unassigned overdue work is not messaged to anyone', async () => {
  reset();
  s.rows = [row({ assignee_id: null, slack_user_id: null, assignee_name: null })];
  await check.run({ orgId: 1, cfg: CFG });
  assert.equal(s.sends.length, 0);
});

test('a message that did not go releases its tasks, so they are mentioned when it next can', async () => {
  reset();
  s.rows = [row({ id: 1, jira_key: 'QG-1' })];
  s.sendResult = { sent: false, reason: 'outside working hours' };
  const out = await check.run({ orgId: 1, cfg: CFG });

  assert.equal(out.held, 1);
  assert.equal(out.tasksMentioned, 0);
  assert.equal(s.history.length, 0, 'no notification history for a message that was not sent');
  assert.equal([...s.claims].filter((k) => k.startsWith('deadline-task:')).length, 0, 'the task claim was released');
});

test('a sent digest is recorded in each person\'s notification history', async () => {
  reset();
  s.rows = [row({ id: 7, jira_key: 'QG-7' }), row({ id: 8, jira_key: 'QG-8' })];
  await check.run({ orgId: 1, cfg: CFG });
  assert.deepEqual(s.history.map((h) => [h.type, h.ref]).sort(), [['deadline_reminder', 7], ['deadline_reminder', 8]]);
});

test('missed deadlines are still recorded for the performance stats, without sending anything itself', async () => {
  reset();
  s.rows = [row()];
  await check.run({ orgId: 1, cfg: CFG });
  assert.equal(s.bookkeeping, 1);
});

// ─── No active sprint ────────────────────────────────────────────────────────

test('with no active sprint it reads overdue work from Jira and sends the same kind of digest', async () => {
  reset();
  s.sprint = null;
  s.members = [{ id: 1, name: 'Bob Stone', email: 'bob@example.com', slack_user_id: 'UBOB' }];
  s.jiraIssues = [
    { key: 'QG-9', summary: 'Rate limiting', assigneeEmail: 'BOB@example.com', assigneeName: 'Bob', duedate: '2026-09-01' },
    { key: 'QG-10', summary: 'No due date', assigneeEmail: 'bob@example.com', duedate: null },
    { key: 'QG-11', summary: 'A stranger', assigneeEmail: 'x@elsewhere.com', assigneeName: 'X', duedate: '2026-09-01' },
  ];
  await check.run({ orgId: 1, cfg: CFG });

  assert.equal(s.bookkeeping, 0, 'no sprint, so no sprint bookkeeping');
  assert.equal(s.sends.length, 1);
  assert.ok(s.sends[0].text.includes('QG-9'));
  assert.ok(!s.sends[0].text.includes('QG-10'), 'no due date means nothing to be past');
  assert.ok(!s.sends[0].text.includes('QG-11'), 'someone not on the team is not guessed at');
});

// ─── Registration ────────────────────────────────────────────────────────────

test('it is still on by default, still schedulable, and described honestly', () => {
  assert.equal(check.defaultEnabled, true);
  assert.equal(check.audience, 'member');
  assert.equal(check.schedule({ deadlineTime: '09:00', workdays: '1-5' }), '0 9 * * 1-5');
  assert.match(check.description, /nobody is escalated to/);
});
