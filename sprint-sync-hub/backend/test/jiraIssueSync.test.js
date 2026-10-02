'use strict';

/**
 * The Jira reader that feeds the task sync. Fixtures mirror real payloads:
 * timestamps with a colon-less offset ("+0000"), a workflow whose done status is
 * called "Resolved", and the Cloud sprint field as an array of objects.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

// Replace axios before the service loads: axios.create() returns a client whose
// .get we control.
const requests = [];
let respond = async () => ({ data: { issues: [] } });

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { create: () => ({ get: async (url, opts) => { requests.push({ url, opts }); return respond(url, opts); } }) },
};

process.env.JIRA_EMAIL = 'lead@example.com';
process.env.JIRA_API_TOKEN = 'token';
process.env.JIRA_SITE_URL = 'https://example.atlassian.net';

const jira = require('../services/jiraService');

function reset() {
  requests.length = 0;
  respond = async () => ({ data: { issues: [] } });
  delete process.env.JIRA_SPRINT_FIELD;
}

const issue = (over = {}) => ({
  key: 'QG-1',
  fields: {
    summary: 'Build login page',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    assignee: { accountId: '5b10a2844c20165700ede21g', displayName: 'Bob', emailAddress: 'bob@example.com' },
    duedate: '2026-09-20',
    priority: { name: 'High' },
    issuetype: { name: 'Story' },
    created: '2026-09-01T09:15:00.000+0000',
    updated: '2026-09-10T14:00:00.000+0000',
    resolutiondate: null,
    customfield_10020: [{ id: 7, name: 'Sprint 7', state: 'active' }],
    ...over,
  },
});

// ─── Timestamps ──────────────────────────────────────────────────────────────

test('Jira timestamps with a colon-less offset parse to the right instant', () => {
  assert.equal(jira.parseJiraTimestamp('2026-08-23T11:31:42.000+0000'), '2026-08-23T11:31:42.000Z');
  assert.equal(jira.parseJiraTimestamp('2026-08-23T11:31:42.000+0530'), '2026-08-23T06:01:42.000Z');
  assert.equal(jira.parseJiraTimestamp('2026-08-23T11:31:42.000-0800'), '2026-08-23T19:31:42.000Z');
});

test('timestamps already in standard form still parse', () => {
  assert.equal(jira.parseJiraTimestamp('2026-08-23T11:31:42.000+05:30'), '2026-08-23T06:01:42.000Z');
  assert.equal(jira.parseJiraTimestamp('2026-08-23T11:31:42Z'), '2026-08-23T11:31:42.000Z');
});

test('missing or malformed timestamps are null, never "Invalid Date"', () => {
  for (const v of [null, undefined, '', 'yesterday', '2026-13-45T99:99:99.000+0000']) {
    assert.equal(jira.parseJiraTimestamp(v), null, String(v));
  }
});

// ─── Normalising an issue ────────────────────────────────────────────────────

test('an in-progress issue keeps its fields and is not done', () => {
  const n = jira.normalizeIssue(issue());
  assert.equal(n.key, 'QG-1');
  assert.equal(n.summary, 'Build login page');
  assert.equal(n.status, 'In Progress');
  assert.equal(n.isDone, false);
  assert.equal(n.assigneeAccountId, '5b10a2844c20165700ede21g');
  assert.equal(n.duedate, '2026-09-20');
  assert.equal(n.issueType, 'Story');
  assert.equal(n.created, '2026-09-01T09:15:00.000Z');
  assert.equal(n.resolved, null);
});

test('completion comes from the status category, so a custom "Shipped" workflow is still done', () => {
  const n = jira.normalizeIssue(issue({
    status: { name: 'Shipped', statusCategory: { key: 'done' } },
    resolutiondate: '2026-09-08T10:00:00.000+0000',
  }));
  assert.equal(n.isDone, true);
  assert.equal(n.resolved, '2026-09-08T10:00:00.000Z');
});

test('a status name that merely sounds finished is not done when the category says otherwise', () => {
  const n = jira.normalizeIssue(issue({ status: { name: 'Done pending QA', statusCategory: { key: 'indeterminate' } } }));
  assert.equal(n.isDone, false);
});

test('with no category the name list is the fallback', () => {
  assert.equal(jira.normalizeIssue(issue({ status: { name: 'Resolved' } })).isDone, true);
  assert.equal(jira.normalizeIssue(issue({ status: { name: 'Closed' } })).isDone, true);
  assert.equal(jira.normalizeIssue(issue({ status: { name: 'In Review' } })).isDone, false);
  assert.equal(jira.normalizeIssue(issue({ status: undefined })).status, 'Unknown');
});

test('a reopened issue has a done history but is no longer done', () => {
  const n = jira.normalizeIssue(issue({
    status: { name: 'Reopened', statusCategory: { key: 'indeterminate' } },
    resolutiondate: null,
  }));
  assert.equal(n.isDone, false);
  assert.equal(n.resolved, null);
});

test('an unassigned issue has no assignee fields', () => {
  const n = jira.normalizeIssue(issue({ assignee: null }));
  assert.equal(n.assigneeAccountId, null);
  assert.equal(n.assigneeEmail, null);
});

test('an assignee whose email is hidden by privacy settings is still identified by account id', () => {
  const n = jira.normalizeIssue(issue({ assignee: { accountId: 'abc123', displayName: 'Carol' } }));
  assert.equal(n.assigneeAccountId, 'abc123');
  assert.equal(n.assigneeEmail, null);
});

test('the sprint field distinguishes "not in a sprint" from "the field was never returned"', () => {
  const backlog = jira.normalizeIssue(issue({ customfield_10020: null }));
  assert.equal(backlog.sprintFieldPresent, true, 'present but null: a backlog item');
  assert.deepEqual(backlog.sprints, []);

  const fields = issue().fields;
  delete fields.customfield_10020;
  const missing = jira.normalizeIssue({ key: 'QG-2', fields });
  assert.equal(missing.sprintFieldPresent, false, 'absent: JIRA_SPRINT_FIELD is probably wrong');
});

test('sprint states are lower-cased and legacy string entries are ignored, not mis-parsed', () => {
  const n = jira.normalizeIssue(issue({
    customfield_10020: [
      { id: 6, name: 'Sprint 6', state: 'CLOSED' },
      { id: 7, name: 'Sprint 7', state: 'ACTIVE' },
      'com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=5,state=ACTIVE]',
    ],
  }));
  assert.deepEqual(n.sprints.map((s) => s.state), ['closed', 'active']);
});

test('a different sprint field id is honoured', () => {
  const raw = issue();
  raw.fields.customfield_10100 = [{ id: 9, name: 'Sprint 9', state: 'active' }];
  delete raw.fields.customfield_10020;
  const n = jira.normalizeIssue(raw, 'customfield_10100');
  assert.equal(n.sprintFieldPresent, true);
  assert.equal(n.sprints[0].name, 'Sprint 9');
});

// ─── Listing ─────────────────────────────────────────────────────────────────

test('it requests exactly the fields the sync needs, including resolution date and the sprint field', async () => {
  reset();
  await jira.listProjectIssues('QG', { sinceDays: 90 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/search/jql');
  const { jql, fields, maxResults } = requests[0].opts.params;
  assert.equal(jql, 'project = "QG" AND updated >= -90d ORDER BY updated DESC');
  assert.equal(maxResults, 100);
  for (const f of ['summary', 'status', 'assignee', 'duedate', 'priority', 'issuetype', 'created', 'updated', 'resolutiondate', 'customfield_10020']) {
    assert.ok(fields.split(',').includes(f), `missing field ${f}`);
  }
});

test('it follows nextPageToken until the last page and normalises every issue', async () => {
  reset();
  respond = async (url, opts) => {
    const token = opts.params.nextPageToken;
    if (!token) return { data: { issues: [issue({ summary: 'one' }), issue({ summary: 'two' })], nextPageToken: 'T2', isLast: false } };
    if (token === 'T2') return { data: { issues: [issue({ summary: 'three' })], nextPageToken: 'T3' } };
    return { data: { issues: [issue({ summary: 'four' })], isLast: true } };
  };

  const out = await jira.listProjectIssues('QG');
  assert.equal(requests.length, 3);
  assert.deepEqual(out.issues.map((i) => i.summary), ['one', 'two', 'three', 'four']);
  assert.equal(out.truncated, false);
  assert.equal(requests[1].opts.params.nextPageToken, 'T2');
});

test('hitting the page cap is reported as truncated, never passed off as complete', async () => {
  reset();
  respond = async () => ({ data: { issues: [issue()], nextPageToken: 'MORE' } });
  const out = await jira.listProjectIssues('QG', { maxPages: 3 });
  assert.equal(requests.length, 3);
  assert.equal(out.truncated, true);
  assert.equal(out.issues.length, 3);
});

test('the look-back is capped, and a nonsensical one falls back to the default', async () => {
  reset();
  for (const v of [99999, 0, -5, 'forever', NaN, 45.9]) await jira.listProjectIssues('QG', { sinceDays: v });
  const days = requests.map((r) => /-(\d+)d /.exec(r.opts.params.jql)[1]);
  assert.deepEqual(days, ['730', '120', '120', '120', '120', '45']);
});

test('a project key that could alter the query is refused before any request is made', async () => {
  reset();
  for (const bad of ['QG" OR project = "SECRET', 'QG; DROP', '', undefined, '1ABC', 'a b', 'QG"']) {
    await assert.rejects(() => jira.listProjectIssues(bad), /not a valid project key/, String(bad));
  }
  assert.equal(requests.length, 0);
});

test('the sprint field id is configurable, and a malformed value cannot reach the request', async () => {
  reset();
  process.env.JIRA_SPRINT_FIELD = 'customfield_10100';
  await jira.listProjectIssues('QG');
  assert.ok(requests[0].opts.params.fields.includes('customfield_10100'));
  assert.ok(!requests[0].opts.params.fields.includes('customfield_10020'));

  requests.length = 0;
  process.env.JIRA_SPRINT_FIELD = 'customfield_1,assignee.emailAddress';
  await jira.listProjectIssues('QG');
  assert.ok(requests[0].opts.params.fields.includes('customfield_10020'), 'a malformed override falls back to the default');
  assert.ok(!requests[0].opts.params.fields.includes('emailAddress'));
  delete process.env.JIRA_SPRINT_FIELD;
});

test('API failures become readable errors', async () => {
  reset();
  respond = async () => { const e = new Error('x'); e.response = { status: 401, data: {} }; throw e; };
  await assert.rejects(() => jira.listProjectIssues('QG'), /Jira listProjectIssues: Invalid credentials \(401\)/);

  respond = async () => { const e = new Error('x'); e.response = { status: 403, data: {} }; throw e; };
  await assert.rejects(() => jira.listProjectIssues('QG'), /Insufficient permissions \(403\)/);
});
