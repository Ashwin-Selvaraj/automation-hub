'use strict';

/**
 * The review digest is the one GitHub feature that messages an engineer, so the
 * tests are mostly about restraint: one message per person, nothing for parked
 * pull requests, nobody guessed at, and wording that never reads as a telling-off.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const sent = [];
let notifierOutcome = { sent: true };
let assessment;
let assessOpts;

stubModule('services/prReviewService', {
  assessWithin: async (org, opts) => { assessOpts = opts; return assessment; },
});
stubModule('core/notifier', {
  sendDM: async (o) => { sent.push(o); return notifierOutcome; },
});

const nudge = require('../automations/code/reviewNudge');

const bob   = { id: 1, name: 'Bob Stone',  slackUserId: 'UBOB' };
const carol = { id: 2, name: 'Carol Ng',   slackUserId: 'UCAROL' };
const noSlack = { id: 3, name: 'Dave', slackUserId: null };

const e = (over) => ({
  kind: 'reviewer', repo: 'acme/api', number: 1, title: 'Add rate limiting',
  url: 'https://github.com/acme/api/pull/1', author: 'alice', reviewer: 'bob-dev',
  member: bob, waitingHours: 30, overSla: true, stale: false, ...over,
});

function setup(waiting, extra = {}) {
  sent.length = 0;
  notifierOutcome = { sent: true };
  assessment = { configured: true, waiting, unassigned: [], errors: [], ...extra };
}

test('it ships disabled, as a reviewer-facing automation in the code category', () => {
  assert.equal(nudge.defaultEnabled, false);
  assert.equal(nudge.audience, 'reviewer');
  assert.equal(nudge.category, 'code');
  assert.equal(nudge.key, 'pr-review-nudge');
});

test('it demands fresh data and is willing to wait for it, because it sends messages', async () => {
  setup([]);
  await nudge.run({ orgId: 1 });
  assert.equal(assessOpts.maxAgeMs, 0);
  assert.ok(assessOpts.budgetMs >= 30_000);
});

test('one message per person, however many pull requests wait on them', async () => {
  setup([
    e({ number: 1 }), e({ number: 2 }), e({ number: 3 }),
    e({ number: 4, member: carol, reviewer: 'carol' }),
  ]);
  const summary = await nudge.run({ orgId: 1 });

  assert.equal(sent.length, 2, 'Bob has three waiting, Carol one — two messages, not four');
  assert.equal(summary.reviewers, 2);
  assert.equal(summary.sent, 2);

  const bobMsg = sent.find((m) => m.slackUserId === 'UBOB');
  assert.equal((bobMsg.text.match(/^• /gm) || []).length, 3, 'all three are in one digest');
  assert.match(bobMsg.text, /3 pull requests are waiting for your review/);
});

test('a single waiting pull request reads grammatically', async () => {
  setup([e({})]);
  await nudge.run({ orgId: 1 });
  assert.match(sent[0].text, /1 pull request is waiting for your review/);
});

test('each digest has a per-person, per-day dedupe key, so a restart cannot send it twice', async () => {
  setup([e({}), e({ number: 2, member: carol, reviewer: 'carol' })]);
  await nudge.run({ orgId: 1 });
  const keys = sent.map((m) => m.dedupeKey).sort();
  assert.match(keys[0], /^pr-review-digest:1:\d{4}-\d{2}-\d{2}$/);
  assert.match(keys[1], /^pr-review-digest:2:\d{4}-\d{2}-\d{2}$/);
  assert.equal(sent[0].type, 'pr_review_digest');
});

test('waits within the SLA are not included', async () => {
  setup([e({ overSla: false, waitingHours: 5 })]);
  const summary = await nudge.run({ orgId: 1 });
  assert.equal(sent.length, 0);
  assert.equal(summary.reviewers, 0);
});

test('parked pull requests are never nudged about — that is the lead\'s call', async () => {
  setup([e({ waitingHours: 1200, stale: true })]);
  await nudge.run({ orgId: 1 });
  assert.equal(sent.length, 0, 'nobody is messaged about a PR that has sat for months');
});

test('a reviewer with nothing but parked work is not messaged, while one with live work is', async () => {
  setup([
    e({ number: 1, stale: true, waitingHours: 900 }),
    e({ number: 2, member: carol, reviewer: 'carol' }),
  ]);
  await nudge.run({ orgId: 1 });
  assert.deepEqual(sent.map((m) => m.slackUserId), ['UCAROL']);
});

test('a parked pull request is left out of a digest that has live ones', async () => {
  setup([e({ number: 1 }), e({ number: 2, stale: true, waitingHours: 900 })]);
  await nudge.run({ orgId: 1 });
  assert.equal((sent[0].text.match(/^• /gm) || []).length, 1);
  assert.ok(!sent[0].text.includes('#2 '));
});

test('a reviewer with no linked Slack account is skipped and counted, never guessed at', async () => {
  setup([
    e({ number: 1, member: null, reviewer: 'stranger' }),
    e({ number: 2, member: noSlack, reviewer: 'dave' }),
    e({ number: 3, member: null, reviewer: 'Stranger' }),
    e({ number: 4 }),
  ]);
  const summary = await nudge.run({ orgId: 1 });

  assert.deepEqual(sent.map((m) => m.slackUserId), ['UBOB'], 'only the linked reviewer is messaged');
  assert.equal(summary.reviewersNotLinked, 2, 'two people, not three pull requests (logins compared case-insensitively)');
});

test('team requests cannot be tied to a person and are left to the lead', async () => {
  setup([e({ kind: 'team', team: 'backend', reviewer: undefined, member: null })]);
  const summary = await nudge.run({ orgId: 1 });
  assert.equal(sent.length, 0);
  assert.equal(summary.teamRequestsLeftToLead, 1);
});

test('pull requests with nobody asked are not sent to anyone — there is no one to send to', async () => {
  setup([], { unassigned: [e({ kind: 'unassigned', member: null, reviewer: undefined })] });
  await nudge.run({ orgId: 1 });
  assert.equal(sent.length, 0);
});

test('a message the notifier held back or de-duplicated is reported, not counted as sent', async () => {
  setup([e({})]);
  notifierOutcome = { sent: false, reason: 'outside working hours' };
  const summary = await nudge.run({ orgId: 1 });
  assert.equal(summary.sent, 0);
  assert.equal(summary.heldOrDuplicate, 1);
});

test('it does nothing, and says why, when GitHub is not configured or did not answer', async () => {
  sent.length = 0;
  assessment = { configured: false, reason: 'GITHUB_TOKEN is not set' };
  assert.deepEqual(await nudge.run({ orgId: 1 }), { skipped: 'GITHUB_TOKEN is not set' });

  assessment = { configured: true, pending: true, waiting: [], unassigned: [], errors: [] };
  assert.match((await nudge.run({ orgId: 1 })).skipped, /did not respond/);
  assert.equal(sent.length, 0);
});

// ─── The wording ─────────────────────────────────────────────────────────────

test('the digest names the pull requests as links, with who opened them and how long they have waited', () => {
  const text = nudge.buildDigest('Bob Stone', [e({ waitingHours: 31 }), e({ number: 2, title: 'Fix login', author: 'carol', waitingHours: 26 })]);

  assert.match(text, /^Hi Bob 👋/);
  assert.ok(text.includes('<https://github.com/acme/api/pull/1|acme/api#1 Add rate limiting>'));
  assert.match(text, /opened by alice, waiting 31 working hours/);
  assert.match(text, /opened by carol, waiting 26 working hours/);
});

test('the digest never reads as a telling-off', () => {
  const text = nudge.buildDigest('Bob', [e({ waitingHours: 80 })]).toLowerCase();
  for (const word of ['overdue', 'late', 'behind', 'slow', 'failed to', 'you must', 'you should', 'need to', 'blocking', 'delay', 'ignored', 'neglect', 'reminder']) {
    assert.ok(!text.includes(word), `the digest must not contain "${word}"`);
  }
});

test('a hostile title cannot mention people or forge a link in the digest', () => {
  const text = nudge.buildDigest('Bob', [e({ title: '<!channel> <@U999> <https://evil.example|bank>', author: '<!here>' })]);
  assert.ok(!text.includes('<!channel>'));
  assert.ok(!text.includes('<@U999>'));
  assert.ok(!text.includes('<!here>'));
  assert.ok(!text.includes('<https://evil.example'));
});

test('a recipient whose name is missing is still greeted sensibly', () => {
  assert.match(nudge.buildDigest('', [e({})]), /^Hi there 👋/);
  assert.match(nudge.buildDigest(undefined, [e({})]), /^Hi there 👋/);
});
