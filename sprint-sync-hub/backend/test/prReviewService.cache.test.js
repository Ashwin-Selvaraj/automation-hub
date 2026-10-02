'use strict';

/**
 * assessWithin(): the time-budgeted, cached way the dashboard reads review waits.
 *
 * A real assessment takes about ten seconds. These tests pin the behaviour that
 * keeps a page load from ever waiting on it: concurrent callers share one fetch,
 * a slow fetch returns the last good answer (or a placeholder) instead of
 * blocking, the slow fetch carries on in the background, and a failure after the
 * caller has already left is never an unhandled rejection.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
process.env.GITHUB_TOKEN = 'x';
process.env.GITHUB_CACHE_SECONDS = '60';

const g = { delayMs: 0, fail: false, listCalls: 0, dbDown: false };

stubModule('services/githubService', {
  isConfigured: () => true,
  getRepos: () => ['acme/api'],
  getInvalidRepos: () => [],
  listOpenPullRequests: async () => {
    g.listCalls++;
    await new Promise((r) => setTimeout(r, g.delayMs));
    if (g.fail) throw new Error('GitHub 500: boom');
    return [];
  },
  listIssueEvents: async () => [],
  listReviews: async () => [],
});
stubModule('repositories/memberRepository', {
  findAll: async () => { if (g.dbDown) throw new Error('database is down'); return []; },
});
stubModule('services/configService', { getSprintConfig: () => ({ timezone: 'UTC', workdays: '1-5' }) });

const svc = require('../services/prReviewService');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

function reset() {
  svc.invalidate();
  g.delayMs = 0; g.fail = false; g.listCalls = 0; g.dbDown = false;
  process.env.GITHUB_CACHE_SECONDS = '60';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a fresh-enough result is returned without another fetch', async () => {
  reset();
  await svc.assessWithin(1);
  await svc.assessWithin(1);
  await svc.assessWithin(1);
  assert.equal(g.listCalls, 1, 'one fetch served three reads');
});

test('callers that arrive together share one in-flight fetch', async () => {
  reset();
  g.delayMs = 30;
  const results = await Promise.all([svc.assessWithin(1), svc.assessWithin(1), svc.assessWithin(1), svc.assessWithin(1)]);
  assert.equal(g.listCalls, 1, 'four concurrent page loads made one set of API calls');
  assert.ok(results.every((r) => r === results[0]), 'and received the same result');
});

test('a slow first fetch returns a pending placeholder inside the budget, not after the fetch', async () => {
  reset();
  g.delayMs = 400;
  const started = Date.now();
  const out = await svc.assessWithin(1, { budgetMs: 50 });

  assert.ok(Date.now() - started < 300, 'the caller did not wait for the slow fetch');
  assert.equal(out.pending, true);
  assert.equal(out.configured, true);
  assert.deepEqual(out.waiting, []);

  // The fetch carries on in the background, so the next read finds it done.
  await sleep(450);
  const next = await svc.assessWithin(1, { budgetMs: 50 });
  assert.equal(next.pending, undefined);
  assert.equal(g.listCalls, 1, 'the background fetch was reused, not repeated');
});

test('a slow refresh returns the last good result marked stale', async () => {
  reset();
  await svc.assessWithin(1);                      // populate the snapshot
  g.delayMs = 300;
  const out = await svc.assessWithin(1, { budgetMs: 40, maxAgeMs: 0 });

  assert.equal(out.stale, true, 'old data is flagged as old');
  assert.equal(out.pending, undefined);
  assert.equal(out.configured, true);
  await sleep(350);                               // let the background refresh settle
});

test('a caller that needs fresh data forces a refresh and waits for it', async () => {
  reset();
  await svc.assessWithin(1);
  g.delayMs = 40;
  const out = await svc.assessWithin(1, { maxAgeMs: 0, budgetMs: 2000 });
  assert.equal(g.listCalls, 2);
  assert.equal(out.stale, undefined);
  assert.equal(out.pending, undefined);
});

test('a failure inside the budget reaches the caller, and the next call retries', async () => {
  reset();
  // GitHub failures are recorded per repository rather than thrown; what can
  // escape assess() is something outside that, such as the member lookup.
  g.dbDown = true;
  await assert.rejects(() => svc.assessWithin(1), /database is down/);

  g.dbDown = false;
  const out = await svc.assessWithin(1);
  assert.equal(out.configured, true, 'the failure was not remembered — the next call tried again');
});

test('a GitHub failure is reported in the result rather than thrown', async () => {
  reset();
  g.fail = true;
  const out = await svc.assessWithin(1);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /GitHub 500/);
});

test('a failure after the caller has already left is not an unhandled rejection', async () => {
  reset();
  unhandled.length = 0;
  g.delayMs = 120;
  g.fail = true;
  const out = await svc.assessWithin(1, { budgetMs: 20 });
  assert.equal(out.pending, true);
  await sleep(250);                               // the background fetch fails here
  assert.deepEqual(unhandled, [], 'the abandoned fetch must not crash the process');
});

test('caching can be switched off, so every read refreshes', async () => {
  reset();
  process.env.GITHUB_CACHE_SECONDS = '0';
  await svc.assessWithin(1);
  await svc.assessWithin(1);
  assert.equal(g.listCalls, 2);
});
