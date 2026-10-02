'use strict';

/**
 * The Jira task sync's decisions: which tasks attach to the active sprint, who is
 * assigned, and — most importantly — that it says so loudly when the picture is
 * incomplete instead of leaving a quietly empty brief.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
process.env.JIRA_EMAIL = 'x@example.com';
process.env.JIRA_API_TOKEN = 't';
process.env.JIRA_SITE_URL = 'https://example.atlassian.net';

const state = {
  issues: [], truncated: false, sprintField: 'customfield_10020',
  members: [], sprint: { id: 5 },
  saved: [], failFor: new Set(), audit: [], cursor: new Map(), claims: new Set(),
  lockAvailable: true, listArgs: null,
};

stubModule('db', {
  query: async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: state.lockAvailable }] };
    return { rows: [] };
  },
});
stubModule('services/jiraService', {
  listProjectIssues: async (key, opts) => { state.listArgs = { key, ...opts }; return { issues: state.issues, truncated: state.truncated, sprintField: state.sprintField }; },
});
stubModule('repositories/taskRepository', {
  syncFromJira: async (org, t) => {
    if (state.failFor.has(t.jiraKey)) throw new Error('value too long for type');
    state.saved.push(t);
    return { id: state.saved.length, inserted: !t.jiraKey.startsWith('OLD') };
  },
});
stubModule('repositories/memberRepository', { findAll: async () => state.members });
stubModule('repositories/sprintRepository', { getActiveSprint: async () => state.sprint });
stubModule('core/auditLog', { record: (org, e) => { state.audit.push(e); return Promise.resolve(); } });
stubModule('core/cursor', {
  get: async (org, k) => state.cursor.get(k) ?? null,
  set: async (org, k, v) => { state.cursor.set(k, v); },
});
stubModule('core/idempotency', {
  claim: async (org, key) => { if (state.claims.has(key)) return false; state.claims.add(key); return true; },
});

const sync = require('../automations/delivery/jiraTaskSync');

const CFG = { projectKey: 'QG', timezone: 'Asia/Kolkata' };

function reset() {
  Object.assign(state, {
    issues: [], truncated: false, sprintField: 'customfield_10020',
    members: [{ id: 1, name: 'Bob', jira_account_id: 'acc-bob', email: 'bob@example.com' },
              { id: 2, name: 'Carol', jira_account_id: null, email: 'carol@example.com' }],
    sprint: { id: 5 }, saved: [], failFor: new Set(), audit: [], cursor: new Map(), claims: new Set(),
    lockAvailable: true, listArgs: null,
  });
  delete process.env.JIRA_SYNC_LOOKBACK_DAYS;
}

const issue = (over = {}) => ({
  key: 'QG-1', summary: 'Build it', status: 'In Progress', statusCategory: 'indeterminate', isDone: false,
  assigneeAccountId: 'acc-bob', assigneeEmail: null, assigneeName: 'Bob',
  duedate: '2026-09-20', priority: 'High', issueType: 'Story',
  created: '2026-09-01T09:00:00.000Z', updated: '2026-09-10T00:00:00.000Z', resolved: null,
  sprintFieldPresent: true, sprints: [{ id: 7, name: 'Sprint 7', state: 'active' }],
  ...over,
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

test('only an active Jira sprint attaches a task to the active sprint', () => {
  const act = [{ state: 'active' }];
  assert.equal(sync.chooseSprint({ sprints: act }, 5), 5);
  assert.equal(sync.chooseSprint({ sprints: [{ state: 'closed' }, { state: 'active' }] }, 5), 5, 'carried over, still active');
  assert.equal(sync.chooseSprint({ sprints: [{ state: 'closed' }] }, 5), undefined, 'a closed sprint leaves the task where it was');
  assert.equal(sync.chooseSprint({ sprints: [{ state: 'future' }] }, 5), undefined);
  assert.equal(sync.chooseSprint({ sprints: [] }, 5), undefined, 'backlog');
  assert.equal(sync.chooseSprint({ sprints: act }, null), undefined, 'no active sprint to attach to');
});

test('assignees are matched by Jira account id first, then by email', () => {
  const memberFor = sync.buildMemberIndex([
    { id: 1, jira_account_id: 'acc-bob', email: 'old@example.com' },
    { id: 2, jira_account_id: null, email: 'Carol@Example.com' },
  ]);
  assert.equal(memberFor({ assigneeAccountId: 'acc-bob', assigneeEmail: 'someone-else@example.com' }), 1, 'the account id wins');
  assert.equal(memberFor({ assigneeAccountId: 'unknown', assigneeEmail: 'carol@example.com' }), 2, 'email, case-insensitively');
  assert.equal(memberFor({ assigneeAccountId: 'unknown', assigneeEmail: null }), null);
  assert.equal(memberFor({ assigneeAccountId: null, assigneeEmail: null }), null);
});

// ─── Running ─────────────────────────────────────────────────────────────────

test('it is skipped, with the reason, when Jira is not configured', async () => {
  reset();
  assert.deepEqual(await sync.run({ orgId: 1, cfg: { ...CFG, projectKey: '' } }), { skipped: 'Jira is not configured' });
  const saved = process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_API_TOKEN;
  assert.match((await sync.run({ orgId: 1, cfg: CFG })).skipped, /not configured/);
  process.env.JIRA_API_TOKEN = saved;
  assert.equal(state.saved.length, 0);
});

test('a second run is turned away while one is in progress', async () => {
  reset();
  state.lockAvailable = false;
  assert.match((await sync.run({ orgId: 1, cfg: CFG })).skipped, /already running/);
  assert.equal(state.saved.length, 0);
});

test('issues are written as Jira reports them, with the right assignee and the active sprint', async () => {
  reset();
  state.issues = [
    issue({ key: 'QG-1' }),
    issue({ key: 'QG-2', assigneeAccountId: null, assigneeEmail: 'carol@example.com', sprints: [] }),
    issue({ key: 'QG-3', statusCategory: 'done', isDone: true, resolved: '2026-09-08T10:00:00.000Z', status: 'Resolved' }),
  ];
  const out = await sync.run({ orgId: 1, cfg: CFG });

  assert.equal(out.fetched, 3);
  assert.equal(out.created, 3);
  const byKey = Object.fromEntries(state.saved.map((t) => [t.jiraKey, t]));
  assert.equal(byKey['QG-1'].assigneeId, 1);
  assert.equal(byKey['QG-1'].sprintId, 5);
  assert.equal(byKey['QG-2'].assigneeId, 2, 'matched by email');
  assert.equal(byKey['QG-2'].sprintId, undefined, 'backlog is not attached');
  assert.equal(byKey['QG-3'].isDone, true);
  assert.equal(byKey['QG-3'].resolvedAt, '2026-09-08T10:00:00.000Z', "Jira's own resolution date is passed through");
  assert.equal(out.done, 1);
  assert.equal(out.attachedToActiveSprint, 2);
});

test("an issue's creation date is the day in the team's calendar, not the UTC day", async () => {
  reset();
  // 20:00 UTC on the 13th is 01:30 on the 14th in Kolkata.
  state.issues = [issue({ created: '2026-09-13T20:00:00.000Z' })];
  await sync.run({ orgId: 1, cfg: CFG });
  assert.equal(state.saved[0].createdOn, '2026-09-14');
});

test('created and updated are counted separately', async () => {
  reset();
  state.issues = [issue({ key: 'QG-1' }), issue({ key: 'OLD-2' })];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.equal(out.created, 1);
  assert.equal(out.updated, 1);
});

test('people outside the team, and unassigned work, are counted rather than guessed at', async () => {
  reset();
  state.issues = [
    issue({ key: 'QG-1' }),
    issue({ key: 'QG-2', assigneeAccountId: 'contractor', assigneeName: 'Contractor' }),
    issue({ key: 'QG-3', assigneeAccountId: null, assigneeEmail: null, assigneeName: null }),
  ];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.equal(out.assignedOutsideTeam, 1);
  assert.equal(out.unassigned, 1);
  assert.equal(state.saved.find((t) => t.jiraKey === 'QG-2').assigneeId, null);
});

test('the look-back comes from the environment and is passed to Jira', async () => {
  reset();
  process.env.JIRA_SYNC_LOOKBACK_DAYS = '200';
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.equal(state.listArgs.sinceDays, 200);
  assert.equal(state.listArgs.key, 'QG');
  assert.equal(out.lookbackDays, 200);
});

// ─── Failing loudly ──────────────────────────────────────────────────────────

test('one issue that cannot be saved does not stop the others, and the reason is reported', async () => {
  reset();
  state.issues = [issue({ key: 'QG-1' }), issue({ key: 'BAD-1' }), issue({ key: 'QG-3' })];
  state.failFor.add('BAD-1');
  const out = await sync.run({ orgId: 1, cfg: CFG });

  assert.equal(out.failed, 1);
  assert.equal(out.created, 2, 'the others were saved');
  assert.ok(out.warnings.some((w) => /BAD-1: value too long/.test(w)), 'the first failure says which issue and why');
});

test('a wrong sprint field is called out, not left as a quietly empty brief', async () => {
  reset();
  state.issues = [issue({ sprintFieldPresent: false, sprints: [] }), issue({ key: 'QG-2', sprintFieldPresent: false, sprints: [] })];
  const out = await sync.run({ orgId: 1, cfg: CFG });

  assert.ok(out.warnings.some((w) => /None of the 2 issues carried the sprint field "customfield_10020"/.test(w)));
  assert.ok(out.warnings.some((w) => /JIRA_SPRINT_FIELD/.test(w)), 'and says how to fix it');
  assert.ok(state.audit.some((e) => e.type === 'jira_task_sync' && e.success === false), 'written to the activity log as a failure');
});

test('backlog-only data is not mistaken for a wrong sprint field', async () => {
  reset();
  state.issues = [issue({ sprintFieldPresent: true, sprints: [] })];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.ok(!out.warnings.some((w) => /sprint field/.test(w)), 'the field exists; the issue is just in the backlog');
});

test('a read cut short is never recorded as complete', async () => {
  reset();
  state.issues = [issue()];
  state.truncated = true;
  const out = await sync.run({ orgId: 1, cfg: CFG });

  assert.equal(out.truncated, true);
  assert.ok(out.warnings.some((w) => /more issues than the sync reads/.test(w)));
  assert.equal(state.cursor.has(sync.COVERS_FROM_KEY), false, 'coverage is not advanced on a partial read');
});

test('no active sprint is reported, since nothing can then be attached to one', async () => {
  reset();
  state.sprint = null;
  state.issues = [issue()];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.ok(out.warnings.some((w) => /no active sprint/.test(w)));
  assert.equal(state.saved[0].sprintId, undefined);
});

test('a team that is mostly unlinked is told to run the member sync', async () => {
  reset();
  state.issues = [
    issue({ key: 'A', assigneeAccountId: 'x1' }), issue({ key: 'B', assigneeAccountId: 'x2' }),
    issue({ key: 'C', assigneeAccountId: 'x3' }), issue({ key: 'D' }),
  ];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.ok(out.warnings.some((w) => /3 of 4 issues are assigned to people who are not linked/.test(w)));
});

test('the same persistent warning is logged once a day, not every hour', async () => {
  reset();
  state.sprint = null;
  state.issues = [issue()];
  await sync.run({ orgId: 1, cfg: CFG });
  await sync.run({ orgId: 1, cfg: CFG });
  await sync.run({ orgId: 1, cfg: CFG });
  const logged = state.audit.filter((e) => /no active sprint/.test(e.details));
  assert.equal(logged.length, 1, 'three hourly runs, one log entry');
});

test('a clean run produces no warnings and no failure entries', async () => {
  reset();
  state.issues = [issue(), issue({ key: 'QG-2' })];
  const out = await sync.run({ orgId: 1, cfg: CFG });
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(state.audit, []);
});

// ─── How far back the data goes ──────────────────────────────────────────────

test('a complete read records how far back coverage reaches, and never moves it forward', async () => {
  reset();
  state.issues = [issue()];
  await sync.run({ orgId: 1, cfg: CFG });
  const first = state.cursor.get(sync.COVERS_FROM_KEY);
  assert.match(first, /^\d{4}-\d{2}-\d{2}$/);

  // A later run with a SHORTER look-back must not claim less history than we have.
  process.env.JIRA_SYNC_LOOKBACK_DAYS = '10';
  await sync.run({ orgId: 1, cfg: CFG });
  assert.equal(state.cursor.get(sync.COVERS_FROM_KEY), first);

  // A LONGER look-back extends it.
  process.env.JIRA_SYNC_LOOKBACK_DAYS = '400';
  await sync.run({ orgId: 1, cfg: CFG });
  assert.ok(state.cursor.get(sync.COVERS_FROM_KEY) < first);
});

test('the automation is on by default, runs hourly, and messages nobody', () => {
  assert.equal(sync.defaultEnabled, true);
  assert.equal(sync.audience, 'system');
  assert.equal(sync.schedule({}), '5 * * * *');
});
