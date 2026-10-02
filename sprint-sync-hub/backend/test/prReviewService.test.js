'use strict';

/**
 * Rules for "who is this pull request waiting on, and for how long".
 *
 * Every fixture mirrors a case seen in real GitHub data: a reviewer added weeks
 * after the PR opened, a bot author, a bot reviewer, a draft marked ready later,
 * a team request. Times are chosen so the expected working hours can be worked
 * out by hand: Asia/Kolkata, 09:00-18:00, Monday-Friday, and "now" is
 * Wednesday 2026-09-16 12:00 IST.
 *
 *   Mon 14th 10:00 -> Wed 12:00 = 8 (Mon) + 9 (Tue) + 3 (Wed) = 20h
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const github = {
  configured: true,
  repos: ['acme/api'],
  pulls: new Map(),    // repo -> [pr]
  events: new Map(),   // `${repo}#${n}` -> [event] | Error
  reviews: new Map(),
  failRepo: new Set(),
  calls: { events: [], reviews: [], inFlight: 0, maxInFlight: 0 },
};

stubModule('services/githubService', {
  isConfigured: () => github.configured,
  getRepos: () => github.repos,
  getInvalidRepos: () => [],
  listOpenPullRequests: async (repo) => {
    if (github.failRepo.has(repo)) { const e = new Error('GitHub 404: Not Found — the repository does not exist or the token cannot access it'); e.code = 'GITHUB_NOT_FOUND'; throw e; }
    return github.pulls.get(repo) || [];
  },
  listIssueEvents: async (repo, n) => {
    github.calls.events.push(n);
    github.calls.inFlight++; github.calls.maxInFlight = Math.max(github.calls.maxInFlight, github.calls.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    github.calls.inFlight--;
    const v = github.events.get(`${repo}#${n}`);
    if (v instanceof Error) throw v;
    return v || [];
  },
  listReviews: async (repo, n) => { github.calls.reviews.push(n); return github.reviews.get(`${repo}#${n}`) || []; },
});

stubModule('repositories/memberRepository', {
  findAll: async () => [
    { id: 1, name: 'Bob',   slack_user_id: 'UBOB',   github_login: 'Bob-Dev' },
    { id: 2, name: 'Carol', slack_user_id: 'UCAROL', github_login: 'carol' },
    { id: 3, name: 'Dave',  slack_user_id: 'UDAVE',  github_login: null },
  ],
});

stubModule('services/configService', {
  getSprintConfig: () => ({ timezone: 'Asia/Kolkata', workdays: '1-5' }),
});

const svc = require('../services/prReviewService');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ist = (date, time) => new Date(`${date}T${time}:00+05:30`).toISOString();
const NOW = new Date(ist('2026-09-16', '12:00'));
const WORK = { timeZone: 'Asia/Kolkata', workStart: '09:00', workEnd: '18:00', workdays: '1-5' };

const human = (login) => ({ login, type: 'User' });
const bot   = (login) => ({ login, type: 'Bot' });

function pr(over = {}) {
  return {
    number: 1, title: 'Add rate limiting', html_url: 'https://github.com/acme/api/pull/1',
    draft: false, user: human('alice'), created_at: ist('2026-09-14', '10:00'),
    requested_reviewers: [], requested_teams: [], labels: [],
    ...over,
  };
}
const asked = (login, at) => ({ event: 'review_requested', created_at: at, requested_reviewer: { login } });
const askedTeam = (slug, at) => ({ event: 'review_requested', created_at: at, requested_team: { slug } });

function run(pulls, events = {}, reviews = {}, extra = {}) {
  return svc.evaluate({
    repo: 'acme/api', pulls,
    eventsByNumber: new Map(Object.entries(events).map(([k, v]) => [Number(k), v])),
    reviewsByNumber: new Map(Object.entries(reviews).map(([k, v]) => [Number(k), v])),
    now: NOW, sla: 24, workTime: WORK, ...extra,
  });
}

// ─── Who is waited on, and since when ────────────────────────────────────────

test('a requested reviewer is waited on from the moment they were asked', () => {
  const out = run(
    [pr({ requested_reviewers: [human('bob')] })],
    { 1: [asked('bob', ist('2026-09-14', '10:00'))] }
  );

  assert.equal(out.waiting.length, 1);
  assert.equal(out.waiting[0].kind, 'reviewer');
  assert.equal(out.waiting[0].reviewer, 'bob');
  assert.equal(out.waiting[0].waitingHours, 20, 'Mon 8h + Tue 9h + Wed 3h');
});

test('each reviewer is dated by their own request, not the pull request\'s', () => {
  // The case seen on a real PR: one reviewer asked on day one, another added later.
  const out = run(
    [pr({ requested_reviewers: [human('bob'), human('carol')] })],
    { 1: [asked('bob', ist('2026-09-14', '10:00')), asked('carol', ist('2026-09-15', '15:00'))] }
  );

  const by = Object.fromEntries(out.waiting.map((w) => [w.reviewer, w.waitingHours]));
  assert.equal(by.bob, 20);
  assert.equal(by.carol, 6, 'Tue 15:00-18:00 (3h) + Wed 09:00-12:00 (3h) — not 20');
});

test('a re-request restarts the clock for that reviewer', () => {
  const out = run(
    [pr({ requested_reviewers: [human('bob')] })],
    { 1: [asked('bob', ist('2026-09-14', '10:00')), asked('bob', ist('2026-09-16', '09:00'))] }
  );
  assert.equal(out.waiting[0].waitingHours, 3, 'the latest request wins');
});

test('a draft marked ready starts its clock when it became ready, not when it opened', () => {
  const out = run(
    [pr({ created_at: ist('2026-09-14', '09:00'), requested_reviewers: [human('bob')] })],
    { 1: [
      asked('bob', ist('2026-09-14', '09:30')),                                 // asked while still a draft
      { event: 'ready_for_review', created_at: ist('2026-09-16', '09:00') },
    ] }
  );
  assert.equal(out.waiting[0].waitingHours, 3, 'Wed 09:00-12:00, not the 29h since the PR opened');
});

test('a team request is waited on as a team and cannot be tied to a person', () => {
  const out = run(
    [pr({ requested_teams: [{ slug: 'backend' }] })],
    { 1: [askedTeam('backend', ist('2026-09-15', '09:00'))] }
  );
  assert.equal(out.waiting.length, 1);
  assert.equal(out.waiting[0].kind, 'team');
  assert.equal(out.waiting[0].team, 'backend');
  assert.equal(out.waiting[0].member, null);
  assert.equal(out.waiting[0].waitingHours, 12, 'Tue 9h + Wed 3h');
});

test('a reviewer asked with no recorded request falls back to when the PR became reviewable', () => {
  const out = run([pr({ requested_reviewers: [human('bob')] })], { 1: [] });
  assert.equal(out.waiting[0].waitingHours, 20);
});

test('GitHub logins match members case-insensitively', () => {
  const members = new Map([['bob-dev', { id: 1, name: 'Bob', slackUserId: 'UBOB' }]]);
  const out = run(
    [pr({ requested_reviewers: [human('BOB-DEV')] })],
    { 1: [asked('BOB-DEV', ist('2026-09-14', '10:00'))] },
    {}, { membersByLogin: members }
  );
  assert.equal(out.waiting[0].member.name, 'Bob');
});

test('an unmapped reviewer is still reported, by login', () => {
  const out = run(
    [pr({ requested_reviewers: [human('stranger')] })],
    { 1: [asked('stranger', ist('2026-09-14', '10:00'))] }
  );
  assert.equal(out.waiting[0].reviewer, 'stranger');
  assert.equal(out.waiting[0].member, null);
});

// ─── What is left out ────────────────────────────────────────────────────────

test('drafts are not waiting on anyone', () => {
  const out = run([pr({ draft: true, requested_reviewers: [human('bob')] })], { 1: [asked('bob', ist('2026-09-14', '10:00'))] });
  assert.deepEqual(out, { waiting: [], unassigned: [] });
});

test('bot-authored pull requests are left out — dependency bumps are not a person waiting', () => {
  const out = run([pr({ user: bot('dependabot[bot]'), requested_reviewers: [human('bob')] })], { 1: [asked('bob', ist('2026-09-14', '10:00'))] });
  assert.deepEqual(out, { waiting: [], unassigned: [] });
});

test('a bot reviewer is not a person owing a review', () => {
  const out = run([pr({ requested_reviewers: [bot('Copilot')] })], { 1: [] }, { 1: [] });
  assert.equal(out.waiting.length, 0, 'nobody human is waited on');
  assert.equal(out.unassigned.length, 1, 'so it reads as having no reviewer');
});

test('an ignored label hides the pull request, whatever its case', () => {
  const out = run(
    [pr({ requested_reviewers: [human('bob')], labels: [{ name: 'Hold' }] })],
    { 1: [asked('bob', ist('2026-09-14', '10:00'))] },
    {}, { ignoreLabels: new Set(['hold']) }
  );
  assert.deepEqual(out, { waiting: [], unassigned: [] });
});

// ─── Pull requests with nobody asked ─────────────────────────────────────────

test('a ready pull request that nobody has been asked to review is reported as such', () => {
  const out = run([pr({ created_at: ist('2026-09-14', '09:00') })], { 1: [] }, { 1: [] });
  assert.equal(out.waiting.length, 0);
  assert.equal(out.unassigned.length, 1);
  assert.equal(out.unassigned[0].kind, 'unassigned');
  assert.equal(out.unassigned[0].waitingHours, 21, 'Mon 9h + Tue 9h + Wed 3h');
});

test('a pull request someone has already reviewed is not "unassigned"', () => {
  // Reviewed, nobody currently owes a review: the ball is with the author.
  const out = run([pr()], { 1: [] }, { 1: [{ user: human('dave'), state: 'COMMENTED' }] });
  assert.deepEqual(out.unassigned, []);
});

test('the author replying to their own PR does not count as a review', () => {
  const out = run([pr()], { 1: [] }, { 1: [{ user: human('alice'), state: 'COMMENTED' }] });
  assert.equal(out.unassigned.length, 1);
});

test('a bot\'s review does not count as a person having looked', () => {
  const out = run([pr()], { 1: [] }, { 1: [{ user: bot('Copilot'), state: 'COMMENTED' }] });
  assert.equal(out.unassigned.length, 1);
});

test('an unsubmitted pending review does not count as looked at', () => {
  const out = run([pr()], { 1: [] }, { 1: [{ user: human('dave'), state: 'PENDING' }] });
  assert.equal(out.unassigned.length, 1);
});

// ─── Not guessing ────────────────────────────────────────────────────────────

test('a pull request whose events could not be read is skipped, not dated by guesswork', () => {
  const out = run([pr({ requested_reviewers: [human('bob')] })], {});
  assert.deepEqual(out, { waiting: [], unassigned: [] });
});

test('a pull request with nobody asked and unreadable reviews is skipped too', () => {
  const out = run([pr()], { 1: [] }, {});
  assert.deepEqual(out, { waiting: [], unassigned: [] });
});

// ─── The SLA ─────────────────────────────────────────────────────────────────

test('waiting exactly the SLA is within it; only longer breaches', () => {
  // Tue 09:00 -> Tue 18:00 = exactly 9h.
  const tue18 = new Date(ist('2026-09-15', '18:00'));
  const base = {
    repo: 'acme/api', now: tue18, workTime: WORK,
    pulls: [pr({ requested_reviewers: [human('bob')] })],
    eventsByNumber: new Map([[1, [asked('bob', ist('2026-09-15', '09:00'))]]]),
  };
  assert.equal(svc.evaluate({ ...base, sla: 9 }).waiting[0].overSla, false, 'exactly 9h against a 9h SLA');
  assert.equal(svc.evaluate({ ...base, sla: 8.9 }).waiting[0].overSla, true);
});

test('results come back longest-waiting first', () => {
  const out = run(
    [
      pr({ number: 1, requested_reviewers: [human('bob')] }),
      pr({ number: 2, requested_reviewers: [human('carol')] }),
    ],
    {
      1: [asked('bob',   ist('2026-09-16', '09:00'))], // 3h
      2: [asked('carol', ist('2026-09-14', '10:00'))], // 20h
    }
  );
  assert.deepEqual(out.waiting.map((w) => w.reviewer), ['carol', 'bob']);
});

test('a pull request opened on Friday evening is not waiting by Saturday', () => {
  const sat = new Date(ist('2026-09-19', '10:00'));
  const out = svc.evaluate({
    repo: 'acme/api', now: sat, sla: 1, workTime: WORK,
    pulls: [pr({ created_at: ist('2026-09-18', '18:00'), requested_reviewers: [human('bob')] })],
    eventsByNumber: new Map([[1, [asked('bob', ist('2026-09-18', '18:00'))]]]),
  });
  assert.equal(out.waiting[0].waitingHours, 0);
  assert.equal(out.waiting[0].overSla, false);
});

// ─── Stale: parked rather than blocked ───────────────────────────────────────

test('a wait beyond the stale threshold is flagged, so months-old PRs do not bury live ones', () => {
  // 20 working hours of waiting. Stale after 15: flagged. Stale after 25: not.
  const base = {
    repo: 'acme/api', now: NOW, sla: 8, workTime: WORK,
    pulls: [pr({ requested_reviewers: [human('bob')] })],
    eventsByNumber: new Map([[1, [asked('bob', ist('2026-09-14', '10:00'))]]]),
  };
  const early = svc.evaluate({ ...base, staleAfter: 15 }).waiting[0];
  assert.equal(early.overSla, true);
  assert.equal(early.stale, true, '20h > 15h');

  const late = svc.evaluate({ ...base, staleAfter: 25 }).waiting[0];
  assert.equal(late.overSla, true, 'still over the SLA');
  assert.equal(late.stale, false, '20h is not > 25h');
});

test('nothing is stale unless a threshold is given', () => {
  const out = run([pr({ requested_reviewers: [human('bob')] })], { 1: [asked('bob', ist('2026-09-14', '10:00'))] });
  assert.equal(out.waiting[0].stale, false);
});

test('the stale threshold is ten working days by default, scaled to the length of the working day', () => {
  delete process.env.GITHUB_REVIEW_STALE_DAYS;
  assert.equal(svc.staleAfterHours({ workStart: '09:00', workEnd: '18:00' }), 90, '10 x a 9-hour day');
  assert.equal(svc.staleAfterHours({ workStart: '10:00', workEnd: '16:00' }), 60, '10 x a 6-hour day');

  process.env.GITHUB_REVIEW_STALE_DAYS = '5';
  assert.equal(svc.staleAfterHours({ workStart: '09:00', workEnd: '18:00' }), 45);

  process.env.GITHUB_REVIEW_STALE_DAYS = 'banana';
  assert.equal(svc.staleAfterHours({ workStart: '09:00', workEnd: '18:00' }), 90, 'a bad value falls back');
  assert.equal(svc.staleAfterHours({ workStart: 'x', workEnd: 'y' }), 90, 'a bad working day falls back to 9h');
  delete process.env.GITHUB_REVIEW_STALE_DAYS;
});

// ─── assess(): fetching, mapping, failing safely ─────────────────────────────

function resetGithub() {
  github.configured = true;
  github.repos = ['acme/api'];
  github.pulls = new Map();
  github.events = new Map();
  github.reviews = new Map();
  github.failRepo = new Set();
  github.calls = { events: [], reviews: [], inFlight: 0, maxInFlight: 0 };
  process.env.GITHUB_TOKEN = 'x';
  delete process.env.GITHUB_REVIEW_SLA_HOURS;
  delete process.env.GITHUB_REVIEW_IGNORE_LABELS;
}

test('assess reports unconfigured, and why, rather than an empty result', async () => {
  resetGithub();
  github.configured = false;
  delete process.env.GITHUB_TOKEN;
  const out = await svc.assess(1, { now: NOW });
  assert.equal(out.configured, false);
  assert.match(out.reason, /GITHUB_TOKEN/);
});

test('assess maps reviewers to members and reads events only for pull requests that could be waiting', async () => {
  resetGithub();
  github.pulls.set('acme/api', [
    pr({ number: 1, requested_reviewers: [human('bob-dev')] }),
    pr({ number: 2, draft: true, requested_reviewers: [human('carol')] }),
    pr({ number: 3, user: bot('dependabot[bot]') }),
  ]);
  github.events.set('acme/api#1', [asked('bob-dev', ist('2026-09-14', '10:00'))]);

  const out = await svc.assess(1, { now: NOW });

  assert.equal(out.configured, true);
  assert.equal(out.waiting.length, 1);
  assert.equal(out.waiting[0].member.name, 'Bob', 'mapped through the stored GitHub login');
  assert.equal(out.waiting[0].waitingHours, 20);
  assert.deepEqual(github.calls.events, [1], 'no calls spent on the draft or the bot PR');
  assert.deepEqual(github.calls.reviews, [], 'reviews are only read where nobody was asked');
});

test('assess reads review history only for pull requests nobody was asked to review', async () => {
  resetGithub();
  github.pulls.set('acme/api', [pr({ number: 7 })]);
  const out = await svc.assess(1, { now: NOW });
  assert.deepEqual(github.calls.reviews, [7]);
  assert.equal(out.unassigned.length, 1);
});

test('one repository the token cannot see does not stop the others, and is reported', async () => {
  resetGithub();
  github.repos = ['acme/api', 'acme/secret'];
  github.failRepo.add('acme/secret');
  github.pulls.set('acme/api', [pr({ number: 1, requested_reviewers: [human('bob-dev')] })]);
  github.events.set('acme/api#1', [asked('bob-dev', ist('2026-09-14', '10:00'))]);

  const out = await svc.assess(1, { now: NOW });

  assert.equal(out.waiting.length, 1, 'the readable repository is still assessed');
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].repo, 'acme/secret');
  assert.equal(out.errors[0].code, 'GITHUB_NOT_FOUND');
});

test('a pull request whose events fail is skipped, and the failure is counted per repository', async () => {
  resetGithub();
  github.pulls.set('acme/api', [
    pr({ number: 1, requested_reviewers: [human('bob-dev')] }),
    pr({ number: 2, requested_reviewers: [human('carol')] }),
    pr({ number: 3, requested_reviewers: [human('carol')] }),
  ]);
  github.events.set('acme/api#1', [asked('bob-dev', ist('2026-09-14', '10:00'))]);
  github.events.set('acme/api#2', new Error('GitHub 500: boom'));
  github.events.set('acme/api#3', new Error('GitHub 500: boom'));

  const out = await svc.assess(1, { now: NOW });

  assert.equal(out.waiting.length, 1, 'only the pull request that could be dated is reported');
  assert.equal(out.errors.length, 1, 'one entry per repository, not one per pull request');
  assert.equal(out.errors[0].skippedPullRequests, 2);
});

test('assess never has more than five requests in flight', async () => {
  resetGithub();
  github.pulls.set('acme/api', Array.from({ length: 14 }, (_, i) => pr({ number: i + 1, requested_reviewers: [human('bob-dev')] })));
  await svc.assess(1, { now: NOW });
  assert.equal(github.calls.events.length, 14);
  assert.ok(github.calls.maxInFlight <= 5, `saw ${github.calls.maxInFlight} in flight`);
  assert.ok(github.calls.maxInFlight > 1, 'and it does run them concurrently');
});

test('the SLA comes from the environment, and a bad value falls back to 24', async () => {
  resetGithub();
  github.pulls.set('acme/api', [pr({ number: 1, requested_reviewers: [human('bob-dev')] })]);
  github.events.set('acme/api#1', [asked('bob-dev', ist('2026-09-14', '10:00'))]);

  process.env.GITHUB_REVIEW_SLA_HOURS = '8';
  let out = await svc.assess(1, { now: NOW });
  assert.equal(out.slaHours, 8);
  assert.equal(out.waiting[0].overSla, true, '20h against an 8h SLA');

  for (const bad of ['0', '-3', 'soon', '']) {
    process.env.GITHUB_REVIEW_SLA_HOURS = bad;
    out = await svc.assess(1, { now: NOW });
    assert.equal(out.slaHours, 24, `"${bad}" falls back to the default`);
  }
});

test('ignored labels come from the environment', async () => {
  resetGithub();
  github.pulls.set('acme/api', [pr({ number: 1, requested_reviewers: [human('bob-dev')], labels: [{ name: 'Do Not Merge' }] })]);
  github.events.set('acme/api#1', [asked('bob-dev', ist('2026-09-14', '10:00'))]);

  process.env.GITHUB_REVIEW_IGNORE_LABELS = 'wip, do not merge';
  const out = await svc.assess(1, { now: NOW });
  assert.equal(out.waiting.length, 0);
});
