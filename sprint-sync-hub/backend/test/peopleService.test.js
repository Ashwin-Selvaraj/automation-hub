'use strict';

/**
 * The people automations are the part of this system that could most easily
 * turn into surveillance. These tests pin the rules that stop it: lead-only,
 * facts with sources, questions rather than verdicts, no rankings, no presence
 * counting — and that each fact is actually right.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
process.env.JIRA_SITE_URL = 'https://acme.atlassian.net';

const state = {
  member: null,
  completed: [], open: [], standups: [], due: [], oneOnOnes: [], actions: [],
  members: [], managerial: new Set(),
  reviews: null,
  github: { configured: false, repos: [], closed: {}, reviews: {}, delayMs: 0 },
  calls: [],
};

stubModule('db', { query: async () => ({ rows: [] }) });
stubModule('repositories/peopleRepository', {
  completedBetween: async (_org, args) => { state.calls.push(['completedBetween', args]); return state.completed; },
  openFor:          async () => state.open,
  dueBetween:       async () => state.due,
  standupsBetween:  async (_org, args) => { state.calls.push(['standupsBetween', args]); return state.standups; },
  recentOneOnOnes:  async (_org, _id, limit) => state.oneOnOnes.slice(0, limit),
  actionsFor:       async () => state.actions,
});
stubModule('repositories/memberRepository', {
  findById: async () => state.member,
  findAll:  async () => state.members,
});
stubModule('repositories/memberRoleRepository', {
  getManagerialMemberKeys: async () => ({ memberIds: state.managerial }),
});
stubModule('services/prReviewService', {
  assessWithin: async () => state.reviews,
});
stubModule('services/githubService', {
  isConfigured: () => state.github.configured,
  getRepos: () => state.github.repos,
  listClosedPullRequestsSince: async (repo) => {
    if (state.github.delayMs) await new Promise((r) => setTimeout(r, state.github.delayMs));
    return state.github.closed[repo] || [];
  },
  listReviews: async (repo, number) => state.github.reviews[`${repo}#${number}`] || [],
});
stubModule('services/configService', {
  getSprintConfig: () => ({ timezone: 'Asia/Kolkata', workdays: '1-5' }),
});

const people = require('../services/peopleService');

function reset() {
  Object.assign(state, {
    member: { id: 5, organisation_id: 1, name: 'Alice Smith', github_login: 'alice-dev' },
    completed: [], open: [], standups: [], due: [], oneOnOnes: [], actions: [],
    members: [], managerial: new Set(), reviews: { configured: false }, calls: [],
    github: { configured: false, repos: [], closed: {}, reviews: {}, delayMs: 0 },
  });
}

const JUDGEMENT_WORDS = [
  'chase', 'warn', 'remind them', 'underperform', 'behind', 'slow', 'lazy',
  'disengaged', 'poor', 'failing', 'not good enough', 'low performer',
];
const RANKING_WORDS = ['top ', 'most ', 'least', '#1', 'leaderboard', 'rank', 'best', 'mvp', 'winner'];

function assertNone(text, words, what) {
  const lowerText = text.toLowerCase();
  for (const w of words) assert.ok(!lowerText.includes(w), `${what} must not contain "${w}"`);
}

// ─── 1:1 schedule ─────────────────────────────────────────────────────────────

test('1:1 prep is due only on the person’s day', () => {
  const m = { one_on_one_weekday: 3, one_on_one_cadence: 'weekly', last_held_on: null };
  assert.equal(people.isOneOnOneDue(m, '2026-09-16'), true, 'a Wednesday');
  assert.equal(people.isOneOnOneDue(m, '2026-09-15'), false, 'a Tuesday');
  assert.equal(people.isOneOnOneDue({ ...m, one_on_one_weekday: null }, '2026-09-16'), false, 'no day set means no prep');
});

test('fortnightly and monthly count from the last recorded 1:1', () => {
  const fortnightly = { one_on_one_weekday: 3, one_on_one_cadence: 'fortnightly' };
  assert.equal(people.isOneOnOneDue({ ...fortnightly, last_held_on: '2026-09-09' }, '2026-09-16'), false, 'one week on');
  assert.equal(people.isOneOnOneDue({ ...fortnightly, last_held_on: '2026-09-02' }, '2026-09-16'), true, 'two weeks on');
  assert.equal(people.isOneOnOneDue({ ...fortnightly, last_held_on: null }, '2026-09-16'), true, 'never held');
  // Moved to a Monday last time: the next Wednesday nine days later is too soon...
  assert.equal(people.isOneOnOneDue({ ...fortnightly, last_held_on: '2026-09-07' }, '2026-09-16'), false);
  // ...and the one after is due, rather than a whole cycle later.
  assert.equal(people.isOneOnOneDue({ ...fortnightly, last_held_on: '2026-09-07' }, '2026-09-23'), true);

  const monthly = { one_on_one_weekday: 3, one_on_one_cadence: 'monthly' };
  assert.equal(people.isOneOnOneDue({ ...monthly, last_held_on: '2026-09-02' }, '2026-09-23'), false);
  assert.equal(people.isOneOnOneDue({ ...monthly, last_held_on: '2026-08-26' }, '2026-09-23'), true);
});

test('a 1:1 already recorded today stops the prep', () => {
  const m = { one_on_one_weekday: 3, one_on_one_cadence: 'weekly', last_held_on: '2026-09-16' };
  assert.equal(people.isOneOnOneDue(m, '2026-09-16'), false);
});

test('a DATE column read back as local midnight is the right day', () => {
  // pg returns DATE as a Date at local midnight; in IST that is the previous day in UTC.
  const m = { one_on_one_weekday: 3, one_on_one_cadence: 'fortnightly', last_held_on: new Date(2026, 8, 2) };
  assert.equal(people.isOneOnOneDue(m, '2026-09-16'), true);
});

// ─── Standup mentions ─────────────────────────────────────────────────────────

test('waiting mentions quote the sentence, not the whole standup', () => {
  const out = people.waitingMentions([
    { post_date: '2026-09-15', message_text: 'Shipped the export. Still waiting on infra for the staging creds. Will pick up QG-9.' },
    { post_date: '2026-09-14', message_text: 'All good today, finished QG-8.' },
    { post_date: '2026-09-12', message_text: 'Blocked by the payments sandbox being down' },
  ]);
  assert.deepEqual(out.map((m) => m.date), ['2026-09-15', '2026-09-12']);
  assert.equal(out[0].text, 'Still waiting on infra for the staging creds.');
});

test('waiting mentions are capped', () => {
  const standups = Array.from({ length: 10 }, (_, i) => ({ post_date: `2026-09-${10 + i}`, message_text: 'stuck on it' }));
  assert.equal(people.waitingMentions(standups).length, 4);
});

// ─── Topics ───────────────────────────────────────────────────────────────────

test('topics are questions about facts, never verdicts about the person', () => {
  const topics = people.suggestTopics({
    stuck: [{ key: 'QG-7', idleDays: 6 }],
    overdue: [{ key: 'QG-2' }, { key: 'QG-3' }],
    mentions: [{ date: '2026-09-15', text: 'waiting on infra' }],
    theirPrs: [{ number: 12, waitingHours: 30, overSla: true }],
    reviewsOwed: [1, 2, 3, 4],
    shipped: [{ key: 'QG-1', openDays: 21 }],
  });
  assert.equal(topics.length, 6);
  assert.match(topics[0], /QG-7 has not moved in 6 days/);
  assert.match(topics[1], /2 tasks \(QG-2, QG-3\) are past due/);
  assert.match(topics[3], /PR #12 has waited 30 working hours/);
  assert.match(topics[5], /QG-1, open for 21 days — worth acknowledging/);
  assertNone(topics.join('\n'), JUDGEMENT_WORDS, 'topics');
});

test('an uneventful fortnight suggests talking about the person, not inventing an issue', () => {
  const topics = people.suggestTopics({});
  assert.equal(topics.length, 1);
  assert.match(topics[0], /Nothing in the data stands out/);
});

test('a PR inside the review SLA is not raised', () => {
  const topics = people.suggestTopics({ theirPrs: [{ number: 12, waitingHours: 5, overSla: false }] });
  assert.ok(!topics.some((t) => t.includes('#12')));
});

// ─── Prep pack ────────────────────────────────────────────────────────────────

test('prep covers the time since the last recorded 1:1', async () => {
  reset();
  state.oneOnOnes = [{ id: 1, held_on: new Date(2026, 8, 2), notes: 'talked about the migration', created_at: '2026-09-02T10:00:00Z' }];
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });

  assert.equal(prep.since, '2026-09-02');
  assert.equal(prep.lastHeldOn, '2026-09-02');
  assert.equal(prep.lastNotes, 'talked about the migration');
  const window = state.calls.find(([name]) => name === 'completedBetween')[1];
  assert.equal(window.from, '2026-09-02');
  assert.equal(window.to, '2026-09-16');
  assert.equal(window.timeZone, 'Asia/Kolkata');
});

test('once today’s 1:1 is recorded, the pack starts again from today', async () => {
  reset();
  state.oneOnOnes = [{ id: 2, held_on: '2026-09-16', notes: 'just now', created_at: '2026-09-16T10:00:00Z' }];
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });
  assert.equal(prep.since, '2026-09-16', 'not the fortnight that was just discussed');
});

test('with no earlier 1:1 the prep covers two weeks', async () => {
  reset();
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });
  assert.equal(prep.since, '2026-09-02');
  assert.equal(prep.lastHeldOn, null);
  assert.match(people.renderPrep(prep), /No earlier 1:1 recorded/);
});

test('prep refuses a member from another organisation', async () => {
  reset();
  state.member = { ...state.member, organisation_id: 2 };
  assert.equal(await people.oneOnOnePrep(1, 5, { today: '2026-09-16' }), null);
});

test('prep sorts open work into late, stalled and in progress', async () => {
  reset();
  state.open = [
    { jira_key: 'QG-1', title: 'Late', status: 'In Progress', due_date: '2026-09-10', last_movement: '2026-09-15T08:00:00Z' },
    { jira_key: 'QG-2', title: 'Stalled', status: 'In Review', due_date: null, last_movement: '2026-09-08T08:00:00Z' },
    { jira_key: 'QG-3', title: 'Moving', status: 'In Progress', due_date: '2026-09-30', last_movement: '2026-09-15T08:00:00Z' },
    { jira_key: 'QG-4', title: 'Not started', status: 'To Do', due_date: null, last_movement: '2026-08-01T08:00:00Z' },
  ];
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });

  assert.deepEqual(prep.overdue.map((t) => t.key), ['QG-1']);
  assert.equal(prep.overdue[0].daysLate, 6);
  assert.deepEqual(prep.stuck.map((t) => t.key), ['QG-2'], 'untouched backlog is not "stalled"');
  assert.deepEqual(prep.inFlight.map((t) => t.key), ['QG-1', 'QG-2', 'QG-3']);
});

test('prep shows their PRs once even when two reviewers owe them', async () => {
  reset();
  const pr = { repo: 'acme/api', number: 12, title: 'Add export', url: 'https://github.com/acme/api/pull/12', author: 'Alice-Dev', waitingHours: 30, overSla: true };
  state.reviews = {
    configured: true,
    waiting: [
      { ...pr, member: { id: 9 } },
      { ...pr, member: { id: 10 } },
      { repo: 'acme/api', number: 20, title: 'Bob’s', url: 'u', author: 'bob', waitingHours: 3, overSla: false, member: { id: 5 } },
    ],
    unassigned: [],
  };
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });

  assert.equal(prep.theirPrs.length, 1, 'login matching is case-insensitive and deduplicated');
  assert.equal(prep.reviewsOwed.length, 1);
  assert.equal(prep.reviewsOwed[0].number, 20);
  assert.equal(prep.github, 'ok');
});

test('prep does not fail when GitHub is still loading', async () => {
  reset();
  state.reviews = { configured: true, pending: true, waiting: [], unassigned: [] };
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });
  assert.equal(prep.github, 'pending');
  assert.deepEqual(prep.theirPrs, []);
});

test('the rendered prep leads with open follow-ups and never judges', async () => {
  reset();
  state.actions = [
    { id: 1, owner: 'lead', text: 'Ask about the conference budget', done_at: null },
    { id: 2, owner: 'member', text: 'Write up the <cache> design', done_at: null },
    { id: 3, owner: 'lead', text: 'Done already', done_at: '2026-09-10T00:00:00Z' },
  ];
  state.completed = [{ jira_key: 'QG-1', title: 'Long one', created_at_jira: '2026-08-20', completed_on: '2026-09-12' }];
  state.standups = [{ post_date: '2026-09-15', message_text: 'Waiting on design for the onboarding flow.' }];
  const prep = await people.oneOnOnePrep(1, 5, { today: '2026-09-16' });
  const text = people.renderPrep(prep);

  assert.ok(text.indexOf('Open follow-ups') < text.indexOf('Worth asking about'));
  assert.match(text, /You: Ask about the conference budget/);
  assert.match(text, /Alice: Write up the &lt;cache&gt; design/, 'user text is escaped');
  assert.ok(!text.includes('Done already'), 'closed follow-ups are not open ones');
  assert.match(text, /QG-1, open for 23 days — worth acknowledging/);
  assert.match(text, /2026-09-15: “Waiting on design for the onboarding flow\.”/);
  assert.match(text, /https:\/\/acme\.atlassian\.net\/browse\/QG-1/);
  assertNone(text, JUDGEMENT_WORDS, 'the prep pack');
  assert.ok(!/standups? posted|attendance|online/i.test(text), 'presence is not measured');
});

// ─── Recognition ──────────────────────────────────────────────────────────────

const ALICE = { id: 1, name: 'Alice', github_login: 'alice' };
const BOB   = { id: 2, name: 'Bob',   github_login: 'bob' };
const CAROL = { id: 3, name: 'Carol', github_login: null };
const DAVE  = { id: 4, name: 'Dave',  github_login: null };

test('recognition names specific work and lists people alphabetically, not by volume', () => {
  const completed = [
    // Bob closes far more than Alice; Alice must still come first.
    ...Array.from({ length: 6 }, (_, i) => ({ assignee_id: 2, jira_key: `QG-${10 + i}`, title: 't', created_at_jira: '2026-09-10', completed_on: '2026-09-15' })),
    { assignee_id: 1, jira_key: 'QG-1', title: 'Old', created_at_jira: '2026-08-01', completed_on: '2026-09-15' },
    { assignee_id: 3, jira_key: 'QG-2', title: 'Early', due_date: '2026-09-20', created_at_jira: '2026-09-10', completed_on: '2026-09-15' },
    { assignee_id: 3, jira_key: 'QG-3', title: 'Bug', issue_type: 'Bug', created_at_jira: '2026-09-10', completed_on: '2026-09-15' },
  ];
  const github = { byLogin: new Map([['alice', { authored: [], reviewed: [1, 2, 3] }], ['bob', { authored: [], reviewed: [1, 2] }]]) };
  const out = people.buildRecognition({ completed, members: [BOB, CAROL, ALICE, DAVE], github });

  assert.deepEqual(out.map((p) => p.name), ['Alice', 'Bob', 'Carol'], 'alphabetical; nobody with nothing is listed');
  assert.deepEqual(out[0].items.map((i) => i.kind), ['long-running', 'reviews']);
  assert.match(out[0].items[0].text, /closed QG-1, which had been open for 45 days/);
  assert.match(out[0].items[1].text, /reviewed 3 teammates' pull requests/);
  assert.deepEqual(out[1].items.map((i) => i.kind), ['closed'], 'two reviews is below the bar; plain closes only when nothing else');
  assert.match(out[1].items[0].text, /closed QG-10, QG-11, QG-12, QG-13 and 2 more/);
  assert.deepEqual(out[2].items.map((i) => i.kind), ['early', 'bugs']);
  assert.match(out[2].items[0].text, /5 days ahead of its due date/);
});

test('recognition leaves out managers and never posts or ranks', async () => {
  reset();
  state.members = [ALICE, BOB];
  state.managerial = new Set([2]);
  state.completed = [
    { assignee_id: 1, jira_key: 'QG-1', title: 'a', created_at_jira: '2026-09-10', completed_on: '2026-09-15' },
    { assignee_id: 2, jira_key: 'QG-2', title: 'b', created_at_jira: '2026-09-10', completed_on: '2026-09-15' },
  ];
  const rec = await people.recognition(1, { from: '2026-09-10', to: '2026-09-16' });
  assert.deepEqual(rec.people.map((p) => p.name), ['Alice']);
  assert.equal(rec.github, 'not-configured');

  const text = people.renderRecognition(rec);
  assert.match(text, /nothing has been posted/);
  assert.match(text, /People not listed may well have done work these tools can’t see/);
  assertNone(text, RANKING_WORDS, 'recognition');
  assertNone(text, JUDGEMENT_WORDS, 'recognition');
});

test('recognition rejects a malformed window', async () => {
  reset();
  await assert.rejects(people.recognition(1, { from: '2026-09-20', to: '2026-09-10' }), { code: 'BAD_WINDOW' });
  await assert.rejects(people.recognition(1, { from: 'last week', to: '2026-09-10' }), { code: 'BAD_WINDOW' });
});

// ─── GitHub activity ──────────────────────────────────────────────────────────

test('reviews are counted per person per PR, excluding authors, bots and drafts', () => {
  const merged = [{ repo: 'a/b', number: 1, title: 'x', html_url: 'u', merged_at: '2026-09-15T10:00:00Z', user: { login: 'Alice' } }];
  const reviews = new Map([['a/b#1', [
    { user: { login: 'bob' }, state: 'COMMENTED' },
    { user: { login: 'Bob' }, state: 'APPROVED' },
    { user: { login: 'alice' }, state: 'COMMENTED' },
    { user: { login: 'dependabot[bot]', type: 'Bot' }, state: 'APPROVED' },
    { user: { login: 'carol' }, state: 'PENDING' },
  ]]]);
  const byLogin = people.activityByLogin(merged, reviews);

  assert.equal(byLogin.get('alice').authored.length, 1);
  assert.equal(byLogin.get('alice').reviewed.length, 0, 'replying on your own PR is not a review');
  assert.equal(byLogin.get('bob').reviewed.length, 1, 'two reviews of one PR count once');
  assert.ok(!byLogin.has('dependabot[bot]'));
  assert.ok(!byLogin.has('carol'), 'an unsubmitted review is not a review');
});

test('merged PRs are placed in the window by the team’s date, not UTC', async () => {
  reset();
  state.github = {
    configured: true, repos: ['a/b'], reviews: {}, delayMs: 0,
    closed: { 'a/b': [
      // 20:00 UTC on the 9th is 01:30 on the 10th in IST: inside a window starting the 10th.
      { number: 1, title: 'late night', merged_at: '2026-09-09T20:00:00Z', updated_at: '2026-09-09T20:00:00Z', user: { login: 'alice' } },
      { number: 2, title: 'too early', merged_at: '2026-09-09T10:00:00Z', updated_at: '2026-09-09T10:00:00Z', user: { login: 'alice' } },
      { number: 3, title: 'closed, not merged', merged_at: null, updated_at: '2026-09-12T10:00:00Z', user: { login: 'alice' } },
    ] },
  };
  const out = await people.githubActivity({ from: '2026-09-10', to: '2026-09-16', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(out.byLogin.get('alice').authored.map((p) => p.number), [1]);
});

test('a slow GitHub is reported as timed out, not as no activity', async () => {
  reset();
  state.github = { configured: true, repos: ['a/b'], closed: {}, reviews: {}, delayMs: 200 };
  const out = await people.githubActivity({ from: '2026-09-10', to: '2026-09-16', timeZone: 'UTC', budgetMs: 20 });
  assert.equal(out.timedOut, true);
});

// ─── Evidence ─────────────────────────────────────────────────────────────────

test('deadlines are sorted into on time, late, open and not yet due', () => {
  const out = people.summariseDeadlines([
    { jira_key: 'A', due_date: '2026-09-10', completed_on: '2026-09-10' },
    { jira_key: 'B', due_date: '2026-09-10', completed_on: '2026-09-13' },
    { jira_key: 'C', due_date: '2026-09-10', completed_on: null },
    { jira_key: 'D', due_date: '2026-09-30', completed_on: null },
  ], '2026-09-16');
  assert.deepEqual(out.onTime.map((t) => t.key), ['A']);
  assert.deepEqual(out.late.map((t) => [t.key, t.daysLate]), [['B', 3]]);
  assert.deepEqual(out.open.map((t) => [t.key, t.daysLate]), [['C', 6]]);
  assert.deepEqual(out.notYetDue.map((t) => t.key), ['D']);
});

test('the evidence pack is facts with sources, says what it cannot see, and leaves out 1:1 notes', async () => {
  reset();
  state.member = { id: 5, organisation_id: 1, name: 'Alice Smith', github_login: null };
  state.completed = [
    { jira_key: 'QG-1', title: 'Payments | refunds', issue_type: 'Story', sprint_name: 'Sprint 7', created_at_jira: '2026-07-01', completed_on: '2026-08-10' },
    { jira_key: 'QG-2', title: 'Fix *rounding*', issue_type: 'Bug', sprint_name: 'Sprint 8', created_at_jira: '2026-08-15', completed_on: '2026-08-20' },
  ];
  state.oneOnOnes = [
    { held_on: '2026-08-05', notes: 'SECRET personal matter' },
    { held_on: '2026-06-01', notes: 'outside the window' },
  ];
  const pack = await people.evidencePack(1, 5, { from: '2026-07-01', to: '2026-09-30' });

  assert.equal(pack.completed.total, 2);
  assert.deepEqual(pack.completed.byType, { Story: 1, Bug: 1 });
  assert.deepEqual(pack.completed.bySprint.map((s) => s.sprint), ['Sprint 7', 'Sprint 8']);
  assert.equal(pack.oneOnOnes.held, 1);
  assert.ok(pack.limits.some((l) => /GitHub is not connected/.test(l)), 'a missing source is named');

  const md = people.renderEvidenceMarkdown(pack);
  assert.ok(!md.includes('SECRET'), '1:1 notes never leave the 1:1 record');
  assert.match(md, /Payments \\\| refunds/, 'Markdown special characters are escaped');
  assert.match(md, /Fix \\\*rounding\\\*/);
  assert.match(md, /open 40 days/);
  assert.match(md, /## What this does not show/);
  assert.match(md, /Work outside Jira and GitHub is not here/);
  assertNone(md, [...JUDGEMENT_WORDS, 'score', 'rating', 'percentile', 'compared to'], 'the evidence pack');
});

test('the evidence pack refuses an unbounded window', async () => {
  reset();
  await assert.rejects(people.evidencePack(1, 5, { from: '2020-01-01', to: '2026-01-01' }), { code: 'BAD_WINDOW' });
  await assert.rejects(people.evidencePack(1, 5, {}), { code: 'BAD_WINDOW' });
});
