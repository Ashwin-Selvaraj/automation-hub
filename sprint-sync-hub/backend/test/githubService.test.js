'use strict';

/**
 * The GitHub client is read-only and handles a credential, so what these tests
 * pin down is mostly what it must NOT do: leak the token into an error, follow
 * a malformed repository name into the URL, or send the token over plain http.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

// axios lives in node_modules, so the backend-relative stub helper cannot reach
// it. Replace it in the require cache directly, before the service loads.
const calls = [];
let responder = async () => ({ data: [], headers: {} });

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { get: async (url, opts) => { calls.push({ url, opts }); return responder(url, opts); } },
};

const SECRET = 'fake-credential-used-only-to-test-redaction-0123456789';

process.env.GITHUB_TOKEN = SECRET;
process.env.GITHUB_REPOS = 'acme/api,acme/web';
delete process.env.GITHUB_API_URL;
process.env.GITHUB_CACHE_SECONDS = '0';

const github = require('../services/githubService');

function reset() {
  calls.length = 0;
  github._resetCache();
  responder = async () => ({ data: [], headers: {} });
  process.env.GITHUB_TOKEN = SECRET;
  process.env.GITHUB_REPOS = 'acme/api,acme/web';
  process.env.GITHUB_CACHE_SECONDS = '0';
  delete process.env.GITHUB_API_URL;
}

// An axios-shaped failure, carrying the request config exactly as axios does —
// which is where the Authorization header lives.
function axiosFailure(status, { message, headers } = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.config = { headers: { Authorization: `Bearer ${SECRET}` }, url: 'https://api.github.com/x' };
  if (status) err.response = { status, data: message ? { message } : {}, headers: headers || {} };
  return err;
}

test('it is configured only with a token and at least one well-formed repository', () => {
  reset();
  assert.equal(github.isConfigured(), true);

  delete process.env.GITHUB_TOKEN;
  assert.equal(github.isConfigured(), false, 'no token');

  process.env.GITHUB_TOKEN = SECRET;
  process.env.GITHUB_REPOS = '';
  assert.equal(github.isConfigured(), false, 'no repositories');

  process.env.GITHUB_REPOS = 'not-a-repo';
  assert.equal(github.isConfigured(), false, 'only malformed names');
});

test('malformed repository names are dropped from reads and reported separately', () => {
  reset();
  process.env.GITHUB_REPOS = 'acme/api, ../etc , acme/ , /x, a/b/c, ./x , acme/web';

  assert.deepEqual(github.getRepos(), ['acme/api', 'acme/web']);
  assert.equal(github.getInvalidRepos().length, 5, 'every bad entry is surfaced, not silently ignored');
  assert.ok(!github.isValidRepoName('../etc'));
  assert.ok(!github.isValidRepoName('../..'));
  assert.ok(!github.isValidRepoName('acme/..'));
  assert.ok(github.isValidRepoName('acme/my.repo-name_2'));
});

test('a request carries the token as a bearer credential, the API version, and a page size', async () => {
  reset();
  await github.listOpenPullRequests('acme/api');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/api/pulls');
  const { headers, params } = calls[0].opts;
  assert.equal(headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(headers['User-Agent'], 'GitHub rejects requests with no User-Agent');
  assert.equal(params.per_page, 100);
  assert.equal(params.state, 'open');
});

test('it follows Link rel="next" across pages and stops when there is none', async () => {
  reset();
  responder = async (url, opts) => {
    const page = opts.params.page;
    return {
      data: [{ n: `p${page}a` }, { n: `p${page}b` }],
      headers: page < 3 ? { link: '<https://api.github.com/x?page=9>; rel="next", <https://api.github.com/x?page=9>; rel="last"' } : {},
    };
  };

  const items = await github.listOpenPullRequests('acme/api');
  assert.equal(calls.length, 3, 'three pages fetched');
  assert.deepEqual(items.map((i) => i.n), ['p1a', 'p1b', 'p2a', 'p2b', 'p3a', 'p3b']);
});

test('pagination is capped so a huge repository cannot run away', async () => {
  reset();
  responder = async () => ({ data: [{ x: 1 }], headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } });
  const warned = [];
  const original = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const items = await github.listOpenPullRequests('acme/api');
    assert.equal(calls.length, 5, 'stops at the page cap');
    assert.equal(items.length, 5);
    assert.ok(warned.some((w) => /more than 500/.test(w)), 'and says so rather than truncating silently');
  } finally {
    console.warn = original;
  }
});

test('responses are cached, and caching can be switched off', async () => {
  reset();
  process.env.GITHUB_CACHE_SECONDS = '60';
  await github.listOpenPullRequests('acme/api');
  await github.listOpenPullRequests('acme/api');
  assert.equal(calls.length, 1, 'the second read is served from cache');

  await github.listOpenPullRequests('acme/web');
  assert.equal(calls.length, 2, 'a different repository is a different entry');

  process.env.GITHUB_CACHE_SECONDS = '0';
  await github.listOpenPullRequests('acme/api');
  assert.equal(calls.length, 3, 'with caching off every read goes out');
});

test('event and review reads target the right paths', async () => {
  reset();
  await github.listIssueEvents('acme/api', 214);
  await github.listReviews('acme/api', 214);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/api/issues/214/events');
  assert.equal(calls[1].url, 'https://api.github.com/repos/acme/api/pulls/214/reviews');
});

test('a malformed repository name never reaches a URL', async () => {
  reset();
  await assert.rejects(() => github.listOpenPullRequests('../../admin'), /not a valid owner\/repo/);
  assert.equal(calls.length, 0, 'no request was made');
});

test('the token is never sent over plain http', async () => {
  reset();
  process.env.GITHUB_API_URL = 'http://github.internal.example';
  await assert.rejects(() => github.listOpenPullRequests('acme/api'), /must use https/);
  assert.equal(calls.length, 0);

  process.env.GITHUB_API_URL = 'https://ghe.example.com/api/v3/';
  await github.listOpenPullRequests('acme/api');
  assert.equal(calls[0].url, 'https://ghe.example.com/api/v3/repos/acme/api/pulls', 'Enterprise URL, trailing slash tolerated');
});

test('GitHub failures become classified errors with a readable hint', async () => {
  reset();
  const cases = [
    [401, 'Bad credentials',     'GITHUB_AUTH',       /token is invalid or expired/],
    [404, 'Not Found',           'GITHUB_NOT_FOUND',  /cannot access it/],
    [429, 'Slow down',           'GITHUB_RATE_LIMIT', /rate limit/],
    [500, 'Server Error',        'GITHUB_ERROR',      /GitHub 500/],
  ];
  for (const [status, message, code, pattern] of cases) {
    responder = async () => { throw axiosFailure(status, { message }); };
    await assert.rejects(
      () => github.listOpenPullRequests('acme/api'),
      (err) => { assert.equal(err.code, code); assert.match(err.message, pattern); assert.equal(err.status, status); return true; },
      `status ${status}`
    );
  }

  responder = async () => { throw axiosFailure(403, { message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0' } }); };
  await assert.rejects(() => github.listOpenPullRequests('acme/api'), (err) => err.code === 'GITHUB_RATE_LIMIT',
    'a 403 with no calls remaining is a rate limit, not a permissions error');

  responder = async () => { const e = axiosFailure(0); e.code = 'ECONNABORTED'; throw e; };
  await assert.rejects(() => github.listOpenPullRequests('acme/api'),
    (err) => err.code === 'GITHUB_NETWORK' && /ECONNABORTED/.test(err.message));
});

test('the token cannot leak through an error, its stack, its serialisation, or its cause', async () => {
  reset();
  // axios errors carry the whole request, Authorization header included. If one
  // were attached as `cause` or logged with console.error(err), the credential
  // would end up in logs.
  for (const failure of [axiosFailure(401, { message: 'Bad credentials' }), axiosFailure(404), axiosFailure(0)]) {
    responder = async () => { throw failure; };
    let caught;
    try { await github.listOpenPullRequests('acme/api'); } catch (err) { caught = err; }

    assert.ok(caught, 'it should have thrown');
    const everything = [caught.message, caught.stack, JSON.stringify(caught), require('util').inspect(caught, { depth: 6 })].join('\n');
    assert.ok(!everything.includes(SECRET), 'the token must not appear anywhere in the error');
    assert.equal(caught.cause, undefined, 'the raw axios error must not be attached');
    assert.equal(caught.config, undefined);
  }
});

test('checkRepoAccess reports a reachable repository as ok and an inaccessible one with the reason', async () => {
  reset();
  assert.deepEqual(await github.checkRepoAccess('acme/api'), { repo: 'acme/api', ok: true });

  responder = async () => { throw axiosFailure(404, { message: 'Not Found' }); };
  const missing = await github.checkRepoAccess('acme/secret');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'GITHUB_NOT_FOUND');
  assert.match(missing.message, /cannot access it/);

  const bad = await github.checkRepoAccess('nonsense');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_NAME');
});

test('checkRepoAccess is never served from cache, so a fixed token is noticed straight away', async () => {
  reset();
  process.env.GITHUB_CACHE_SECONDS = '60';
  await github.checkRepoAccess('acme/api');
  await github.checkRepoAccess('acme/api');
  assert.equal(calls.length, 2);
});

test('with no token it fails clearly rather than sending an unauthenticated request', async () => {
  reset();
  delete process.env.GITHUB_TOKEN;
  await assert.rejects(() => github.listOpenPullRequests('acme/api'), (err) => err.code === 'GITHUB_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
});
