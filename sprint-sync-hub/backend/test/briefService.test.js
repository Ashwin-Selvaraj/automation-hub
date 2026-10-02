'use strict';

/**
 * The brief is the thing a lead reads every morning, so the renderer has to be
 * right about two things: it must show every signal it was given, and it must
 * never read as an instruction to go and chase somebody.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

stubModule('db', { query: async () => ({ rows: [] }) });

const briefService = require('../services/briefService');

const FULL = {
  date: '2026-09-15',
  sprint: 'Sprint 7',
  daysLeft: 4,
  progress: { total: 20, done: 12, notStarted: 3 },
  blockers: [
    { name: 'Alice', summary: 'waiting on staging credentials', waitingOn: 'infra' },
    { name: 'Bob',   summary: 'needs review on QG-14',          waitingOn: null },
  ],
  overdue: [{ key: 'QG-12', title: 'Payment flow', assignee: 'Alice', daysOverdue: 3 }],
  dueSoon: [{ key: 'QG-19', title: 'Rate limiting', assignee: 'Bob', daysUntil: 0, status: 'To Do' }],
  stale:   [{ key: 'QG-7',  title: 'Refactor auth', assignee: 'Bob', status: 'In Progress' }],
  offPlan: [{ name: 'Carol', detail: 'working on QG-31, assigned to Dave', key: 'QG-31', type: 'unassigned_task' }],
  wip: [{ name: 'Alice', inFlight: 5, over: 2, keys: ['QG-1', 'QG-2', 'QG-3'] }],
  wipLimit: 3,
  scopeAdded: [{ key: 'QG-20', title: 'Hotfix: CSV export', assignee: 'Bob', addedOn: '2026-09-11', done: false }],
  scopeAddedShare: 21,
  forecast: {
    status: 'at-risk',
    summary: 'At this rate 10 tasks will not land — closing 0.5 a day, 11 open, 2 working days left.',
  },
  noUpdate:  ['Dave'],
  unmatched: ['Erin'],
  absent: ['Frank'],
  postedCount: 4,
  focus: 'Alice has been blocked on staging credentials for two days; that is the one thing likely to cost the sprint.',
};

const EMPTY = {
  date: '2026-09-15', sprint: 'Sprint 7', daysLeft: 4,
  progress: { total: 0, done: 0, notStarted: 0 },
  blockers: [], overdue: [], dueSoon: [], stale: [], offPlan: [],
  noUpdate: [], unmatched: [], absent: [], postedCount: 0,
};

test('every signal given to the renderer appears in the output', () => {
  const out = briefService.render(FULL);

  for (const needle of [
    'Alice', 'waiting on infra', 'Bob', 'QG-12', '3 days late',
    'QG-19', 'QG-7', 'Carol', 'QG-31', 'Dave', 'Erin',
    '5 in flight', 'Holding more than 3', 'QG-20', '2026-09-11',
    '21% of the sprint', '10 tasks will not land',
  ]) {
    assert.ok(out.includes(needle), `expected the brief to mention "${needle}"`);
  }

  // Every field the renderer reads must survive the mapping into signals.
  assert.ok(!out.includes('undefined'), 'no field may render as undefined');
});

test('the focus line leads, so the first thing read is the thing to act on', () => {
  const out = briefService.render(FULL);
  const focusAt   = out.indexOf('Alice has been blocked');
  const blockerAt = out.indexOf('⛔');
  assert.ok(focusAt > 0 && focusAt < blockerAt, 'focus must come before the detail');
});

test('a quiet day says so rather than inventing work', () => {
  const out = briefService.render(EMPTY);
  assert.match(out, /Nothing needs your attention/);
  assert.ok(!out.includes('⛔'), 'no empty sections');
  assert.ok(!out.includes('⏰'), 'no empty sections');
});

test('the quiet-today section is framed as context, not a chase list', () => {
  const out = briefService.render(FULL);
  assert.match(out, /has not messaged anyone about this/,
    'the lead must know the bot stayed silent, so they choose whether to raise it');
});

test('the brief never tells the lead to chase, warn, or discipline anyone', () => {
  const out = briefService.render(FULL).toLowerCase();
  for (const word of ['chase', 'warn', 'remind them', 'follow up with', 'discipline', 'underperform']) {
    assert.ok(!out.includes(word), `the brief must not contain "${word}"`);
  }
});

test('an absent member is not listed as quiet', () => {
  const out = briefService.render(FULL);
  const quietSection = out.slice(out.indexOf('🔇'));
  assert.ok(!quietSection.includes('Frank'), 'someone recorded absent is off, not silent');
});

test('long lists are truncated rather than filling the message', () => {
  const many = {
    ...EMPTY,
    overdue: Array.from({ length: 12 }, (_, i) => ({
      key: `QG-${i}`, title: `Task ${i}`, assignee: 'Alice', daysOverdue: i + 1,
    })),
  };
  const out = briefService.render(many);
  assert.match(out, /and 4 more/);
  assert.ok(!out.includes('QG-11'), 'items past the cap are summarised, not listed');
});


// ─── Pull requests waiting on review ─────────────────────────────────────────

const REVIEW = {
  reviewsConfigured: true,
  reviewSlaHours: 24,
  reviewStaleDays: 10,
  reviewParked: 0,
  reviewErrors: [],
  reviewsPending: false,
  reviewsStale: false,
  reviewWaiting: [
    { repo: 'acme/api', number: 214, title: 'Add rate limiting', url: 'https://github.com/acme/api/pull/214', author: 'alice', who: 'Bob', waitingHours: 31, kind: 'reviewer' },
    { repo: 'acme/web', number: 90,  title: 'Fix login redirect', url: 'https://github.com/acme/web/pull/90', author: 'carol', who: 'team backend', waitingHours: 26, kind: 'team' },
  ],
  reviewUnassigned: [
    { repo: 'acme/api', number: 219, title: 'Retry failed webhooks', url: 'https://github.com/acme/api/pull/219', author: 'dave', who: null, waitingHours: 40, kind: 'unassigned' },
  ],
};

test('the brief says who each pull request is waiting on, and for how long, as links', () => {
  const out = briefService.render({ ...FULL, ...REVIEW });

  assert.match(out, /\*🔍 Waiting on review — 3\*/);
  assert.ok(out.includes('<https://github.com/acme/api/pull/214|acme/api#214 Add rate limiting>'), 'a real Slack link');
  assert.match(out, /waiting on \*Bob\* for 31 working hours/);
  assert.match(out, /waiting on \*team backend\* for 26 working hours/);
  assert.match(out, /nobody asked to review it yet, 40 working hours/);
  assert.match(out, /Past the 24 working-hour mark/);
  assert.ok(!out.includes('undefined'));
});

test('a pull request title cannot mention people or forge a link in the brief', () => {
  const hostile = {
    ...REVIEW,
    reviewWaiting: [{
      ...REVIEW.reviewWaiting[0],
      title: '<!channel> urgent <@U123> <https://evil.example|your bank>',
      who: '<!here>',
    }],
    reviewUnassigned: [],
  };
  const out = briefService.render({ ...EMPTY, ...hostile });

  assert.ok(!out.includes('<!channel>'), 'no channel mention');
  assert.ok(!out.includes('<@U123>'), 'no user mention');
  assert.ok(!out.includes('<!here>'), 'no here mention');
  assert.ok(!out.includes('<https://evil.example'), 'no forged link');
  assert.ok(out.includes('&lt;!channel&gt;'), 'shown as plain text instead');
});

test('long-parked pull requests are counted in one line, not listed', () => {
  const out = briefService.render({ ...EMPTY, ...REVIEW, reviewWaiting: [], reviewUnassigned: [], reviewParked: 26 });

  assert.match(out, /26 more have been waiting over 10 working days — likely parked, so not listed/);
  assert.ok(!out.includes('acme/api#'), 'none are listed individually');
});

test('a single parked pull request reads grammatically', () => {
  const out = briefService.render({ ...EMPTY, ...REVIEW, reviewWaiting: [], reviewUnassigned: [], reviewParked: 1 });
  assert.match(out, /1 more has been waiting/);
});

test('a repository that could not be read is called out, not silently left empty', () => {
  const out = briefService.render({
    ...EMPTY, ...REVIEW, reviewWaiting: [], reviewUnassigned: [],
    reviewErrors: [
      { repo: 'acme/secret', error: 'GitHub 404: Not Found — the repository does not exist or the token cannot access it', code: 'GITHUB_NOT_FOUND' },
      { repo: 'acme/api', error: 'GitHub 500', skippedPullRequests: 2 },
    ],
  });

  assert.match(out, /Review waits are incomplete/);
  assert.match(out, /acme\/secret \(GitHub 404/);
  assert.match(out, /acme\/api \(2 pull requests couldn't be read\)/);
  assert.ok(!out.includes('Nothing needs your attention'), 'an incomplete picture is not "all clear"');
});

test('data still loading is said to be loading, not reported as empty', () => {
  const out = briefService.render({ ...EMPTY, ...REVIEW, reviewWaiting: [], reviewUnassigned: [], reviewsPending: true });
  assert.match(out, /still loading from GitHub/);
});

test('with GitHub not configured the brief has no review section at all', () => {
  const out = briefService.render({ ...FULL, reviewsConfigured: false, reviewWaiting: [], reviewUnassigned: [] });
  assert.ok(!out.includes('Waiting on review'));
  assert.ok(!out.includes('GitHub'));
});

test('a long list of waiting pull requests is capped', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...REVIEW.reviewWaiting[0], number: 300 + i, who: 'Bob', waitingHours: 50 - i,
  }));
  const out = briefService.render({ ...EMPTY, ...REVIEW, reviewWaiting: many, reviewUnassigned: [] });
  assert.match(out, /and 4 more/);
  assert.ok(out.includes('#307'), 'the eighth is shown');
  assert.ok(!out.includes('#308'), 'the ninth is not');
});

test('the review section never reads as an instruction to chase anyone', () => {
  const out = briefService.render({ ...FULL, ...REVIEW, reviewParked: 3 }).toLowerCase();
  for (const word of ['chase', 'warn', 'remind them', 'follow up with', 'discipline', 'overdue review', 'slow']) {
    assert.ok(!out.includes(word), `the brief must not contain "${word}"`);
  }
});

// ─── summariseReviews: what is shown, and what is only counted ───────────────

const entry = (over) => ({
  kind: 'reviewer', repo: 'acme/api', number: 1, title: 'T', url: 'https://github.com/acme/api/pull/1',
  author: 'alice', reviewer: 'bob', member: null, waitingHours: 30, overSla: true, stale: false, ...over,
});

test('only over-SLA, non-parked waits are listed; parked ones are counted', () => {
  const out = briefService.summariseReviews({
    configured: true, slaHours: 24, staleDays: 10, errors: [],
    waiting: [
      entry({ number: 1, waitingHours: 30 }),                          // listed
      entry({ number: 2, waitingHours: 5, overSla: false }),           // within SLA
      entry({ number: 3, waitingHours: 500, stale: true }),            // parked
    ],
    unassigned: [entry({ kind: 'unassigned', number: 4, overSla: true, stale: true })],
  });

  assert.deepEqual(out.reviewWaiting.map((e) => e.number), [1]);
  assert.equal(out.reviewParked, 2, 'one parked wait and one parked unassigned');
  assert.equal(out.reviewsConfigured, true);
});

test('a reviewer is named as the member, else the team, else the login', () => {
  const out = briefService.summariseReviews({
    configured: true, slaHours: 24, staleDays: 10, errors: [], unassigned: [],
    waiting: [
      entry({ number: 1, member: { name: 'Bob Stone' } }),
      entry({ number: 2, kind: 'team', team: 'backend', reviewer: undefined }),
      entry({ number: 3, reviewer: 'stranger' }),
    ],
  });
  assert.deepEqual(out.reviewWaiting.map((e) => e.who), ['Bob Stone', 'team backend', '@stranger']);
});

test('an unconfigured or missing assessment yields the same keys, all empty', () => {
  for (const input of [null, undefined, { configured: false }]) {
    const out = briefService.summariseReviews(input);
    assert.equal(out.reviewsConfigured, false);
    assert.deepEqual(out.reviewWaiting, []);
    assert.deepEqual(out.reviewUnassigned, []);
    assert.equal(out.reviewParked, 0);
  }
});

test('a pending or stale assessment is flagged so the brief can say so', () => {
  const pending = briefService.summariseReviews({ configured: true, pending: true, waiting: [], unassigned: [], errors: [] });
  assert.equal(pending.reviewsPending, true);
  const stale = briefService.summariseReviews({ configured: true, stale: true, waiting: [], unassigned: [], errors: [] });
  assert.equal(stale.reviewsStale, true);
});
