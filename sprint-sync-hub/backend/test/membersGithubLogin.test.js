'use strict';

/**
 * PATCH /api/members/:memberId/github-login — mounts the real router and calls
 * it over HTTP, with the data layer stubbed.
 *
 * GitHub usernames are typed by hand, so the endpoint has to be forgiving about
 * what people paste ("@bob-dev") and strict about what it stores.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const express = require('express');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const state = { members: new Map(), saved: [], audit: [], taken: new Set(), invalidations: 0 };

stubModule('repositories/memberRepository', {
  findById: async (id) => state.members.get(Number(id)) || null,
  setGithubLogin: async (id, login) => {
    if (login && state.taken.has(login.toLowerCase())) {
      const e = new Error('That GitHub username is already linked to another team member');
      e.code = 'GITHUB_LOGIN_TAKEN';
      throw e;
    }
    state.saved.push({ id, login });
    return { ...state.members.get(Number(id)), github_login: login };
  },
});
stubModule('repositories/memberRoleRepository', { getAllMembersWithRoles: async () => [] });
stubModule('services/slackService', {});
stubModule('services/jiraService', {});
stubModule('services/prReviewService', { invalidate: () => { state.invalidations++; } });
stubModule('core/auditLog', { record: (org, entry) => { state.audit.push(entry); return Promise.resolve(); } });

const router = require('../routes/members');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/members', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function reset() {
  state.members = new Map([
    [1, { id: 1, organisation_id: 1, name: 'Bob', github_login: null }],
    [2, { id: 2, organisation_id: 99, name: 'Someone Else', github_login: null }],
  ]);
  state.saved = [];
  state.audit = [];
  state.taken = new Set();
  state.invalidations = 0;
}

async function patch(id, body) {
  const res = await fetch(`${base}/api/members/${id}/github-login`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('a valid username is saved and the change is audited', async () => {
  reset();
  const res = await patch(1, { githubLogin: 'bob-dev' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.member.github_login, 'bob-dev');
  assert.deepEqual(state.saved, [{ id: 1, login: 'bob-dev' }]);
  assert.equal(state.audit[0].type, 'github_login_set');
  assert.match(state.audit[0].action, /linked for Bob/);
});

test('a pasted @ and surrounding spaces are tolerated', async () => {
  reset();
  const res = await patch(1, { githubLogin: '  @bob-dev  ' });
  assert.equal(res.status, 200);
  assert.equal(state.saved[0].login, 'bob-dev');
});

test('an empty value, whitespace, or null clears the link', async () => {
  for (const value of ['', '   ', null]) {
    reset();
    const res = await patch(1, { githubLogin: value });
    assert.equal(res.status, 200, `value ${JSON.stringify(value)}`);
    assert.deepEqual(state.saved, [{ id: 1, login: null }]);
    assert.match(state.audit[0].action, /unlinked/);
  }
});

test('a missing body field clears too, rather than erroring', async () => {
  reset();
  const res = await patch(1, {});
  assert.equal(res.status, 200);
  assert.equal(state.saved[0].login, null);
});

test('names GitHub would not allow are refused, with a message that says what is allowed', async () => {
  const bad = ['-bob', 'bob-', 'bob--dev', 'bob dev', 'bob/dev', 'bob.dev', 'x'.repeat(40), 'bob@dev', 'https://github.com/bob', '<script>'];
  for (const name of bad) {
    reset();
    const res = await patch(1, { githubLogin: name });
    assert.equal(res.status, 400, `"${name}" should be refused`);
    assert.match(res.body.error, /not a valid GitHub username/);
    assert.deepEqual(state.saved, [], 'nothing is stored');
  }
});

test('the longest and shortest legal names are accepted', async () => {
  for (const name of ['a', 'ab', 'a-b', 'x'.repeat(39), 'Bob-Dev-2']) {
    reset();
    const res = await patch(1, { githubLogin: name });
    assert.equal(res.status, 200, `"${name}" should be accepted`);
  }
});

test('a member in another organisation is reported as not found, not as forbidden', async () => {
  reset();
  const res = await patch(2, { githubLogin: 'bob-dev' });
  assert.equal(res.status, 404, 'no hint that the member exists elsewhere');
  assert.deepEqual(state.saved, []);
});

test('an unknown member is not found', async () => {
  reset();
  assert.equal((await patch(12345, { githubLogin: 'bob-dev' })).status, 404);
});

test('a non-numeric member id is a bad request', async () => {
  reset();
  assert.equal((await patch('abc', { githubLogin: 'bob-dev' })).status, 400);
});

test('a username already linked to someone else is a conflict', async () => {
  reset();
  state.taken.add('bob-dev');
  const res = await patch(1, { githubLogin: 'Bob-Dev' });
  assert.equal(res.status, 409, 'uniqueness is case-insensitive');
  assert.match(res.body.error, /already linked/);
});

test('a successful change discards cached review waits, so the new name shows straight away', async () => {
  reset();
  await patch(1, { githubLogin: 'bob-dev' });
  assert.equal(state.invalidations, 1);

  await patch(1, { githubLogin: '' });
  assert.equal(state.invalidations, 2, 'unlinking changes the labels too');
});

test('a refused change leaves the cache alone', async () => {
  reset();
  await patch(1, { githubLogin: 'bad name' });   // 400
  await patch(999, { githubLogin: 'bob-dev' });  // 404
  state.taken.add('taken');
  await patch(1, { githubLogin: 'taken' });      // 409
  assert.equal(state.invalidations, 0);
});
