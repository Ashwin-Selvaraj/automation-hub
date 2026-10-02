'use strict';

/**
 * "Today" is the team's today. The server clock is UTC (or whatever the host is
 * set to), and for a team in Kolkata the UTC date is still yesterday until
 * 05:30 — so every stats row, dedupe key and overdue cut-off written in that
 * window used to land on the wrong day.
 *
 * Every test here freezes the clock at 20:00 UTC on Tuesday 15 Sept 2026, which
 * is 01:30 on Wednesday the 16th in Kolkata, on a server set to New York — a
 * zone that is behind UTC, so a bug in either direction shows.
 */

process.env.TZ = 'America/New_York';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const express = require('express');
const request = require('supertest');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
process.env.JIRA_EMAIL = 'a@example.com';
process.env.JIRA_API_TOKEN = 'x';
process.env.JIRA_SITE_URL = 'https://acme.atlassian.net';

const NOW = new Date('2026-09-15T20:00:00Z');   // 01:30 on the 16th in Kolkata
const TEAM_TODAY = '2026-09-16';

const cfg = { timezone: 'Asia/Kolkata', workdays: '1-5', teamMembers: [] };
const calls = { stats: [], deadline: [], jiraGets: [], recordPost: [], notif: [] };

stubModule('db', { query: async () => ({ rows: [] }) });
stubModule('services/configService', { getSprintConfig: () => cfg });
stubModule('core/auditLog', { record: () => Promise.resolve() });
stubModule('repositories/statsRepository', {
  upsertDailyStats: async (...a) => { calls.stats.push(a); },
  getOverallStats: async () => ({}),
  upsertOverallStats: async () => {},
  getDailyStats: async () => [],
});
stubModule('repositories/notificationRepository', { recordNotification: async (...a) => { calls.notif.push(a); } });
stubModule('repositories/deadlineRepository', {
  findByTaskId: async () => ({ id: 9, due_date: new Date(2026, 8, 10) }), // a pg DATE: local midnight
  updateStatus: async (...a) => { calls.deadline.push(a); },
  recordDeadlineEvent: async () => {},
});
stubModule('repositories/taskRepository', {
  markCompleted: async () => {},
  getOverdueTasks: async () => [],
});
stubModule('repositories/standupRepository', {
  recordPost: async (...a) => { calls.recordPost.push(a); return { id: 5 }; },
  getPostsForMemberInSprint: async () => [],
  findByMemberAndDate: async () => null,
});
stubModule('repositories/memberRepository', { findOrCreate: async () => ({ id: 3, name: 'Alice' }), findAll: async () => [], findById: async () => ({ id: 3, organisation_id: 1 }) });
stubModule('repositories/sprintRepository', {
  findById: async () => ({ id: 7, start_date: new Date(2026, 8, 7), end_date: new Date(2026, 8, 18) }),
  getActiveSprint: async () => null,
});
stubModule('repositories/memberRoleRepository', {});
stubModule('services/scoringService', {});

// axios: Jira's client is axios.create(...) and GitHub is not used here.
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { create: () => ({ get: async (url, opts) => {
    calls.jiraGets.push({ url, opts });
    return { data: { issues: [{ key: 'QG-1', fields: { summary: 's', status: { name: 'To Do' }, duedate: '2026-09-10', assignee: null } }] } };
  } }) },
};

const { mock } = test;

test.beforeEach(() => {
  for (const k of Object.keys(calls)) calls[k] = [];
  cfg.timezone = 'Asia/Kolkata';
  cfg.workdays = '1-5';
  mock.timers.enable({ apis: ['Date'], now: NOW });
});
test.afterEach(() => mock.timers.reset());

const teamClock = require('../utils/teamClock');
const dateOnly  = require('../utils/dateOnly');

test('the team’s today is not the server’s, in either direction', () => {
  assert.equal(new Date().toISOString().slice(0, 10), '2026-09-15', 'UTC is still the 15th');
  assert.equal(new Date().getDate(), 15, 'so is a server in New York');
  assert.equal(teamClock.today(), TEAM_TODAY);
  assert.equal(teamClock.dateOf(new Date('2026-09-15T18:29:00Z')), '2026-09-15', 'one minute before the team’s midnight');
  assert.equal(teamClock.dateOf(new Date('2026-09-15T18:30:00Z')), '2026-09-16', 'the team’s midnight');
});

test('calendar arithmetic on date strings does not depend on the server’s zone or DST', () => {
  // The US spring-forward is 8 March 2026; stepping a Date by setDate across it
  // in a New York server can land on the wrong day.
  assert.equal(dateOnly.addDays('2026-03-07', 2), '2026-03-09');
  assert.equal(dateOnly.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dateOnly.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(dateOnly.weekdayOf('2026-09-16'), 3);
});

test('working dates follow the team’s working days, not a fixed Saturday and Sunday', () => {
  // 14 Sept 2026 is a Monday; the 19th and 20th are the weekend.
  assert.equal(dateOnly.workingDatesBetween('2026-09-14', '2026-09-20').length, 5);
  assert.equal(dateOnly.workingDatesBetween('2026-09-14', '2026-09-20', '1-6').length, 6);
  assert.deepEqual(dateOnly.workingDatesBetween('2026-09-14', '2026-09-14', '1-5'), ['2026-09-14']);
  // A pg DATE read back as local midnight is the right day too.
  assert.deepEqual(dateOnly.workingDatesBetween(new Date(2026, 8, 14), new Date(2026, 8, 15)), ['2026-09-14', '2026-09-15']);
});

test('stats are recorded against the team’s day', async () => {
  const perf = require('../services/performanceService');
  await perf.recordNoMatchDM(1, 7, 3, '1.1');
  assert.equal(calls.stats[0][3], TEAM_TODAY);
});

test('a task finished after midnight IST is recorded on the team’s day, with the right days late', async () => {
  const perf = require('../services/performanceService');
  await perf.recordJiraSync(1, 7, 3, 11, 'In Progress', 'Done', 'slack_sync');
  const [, status, completedOn, daysOverdue] = calls.deadline[0];
  assert.equal(status, 'missed');
  assert.equal(completedOn, TEAM_TODAY);
  assert.equal(daysOverdue, 6, 'due the 10th, finished the 16th');
  assert.equal(calls.stats[0][3], TEAM_TODAY);
});

test('a standup posted at 01:30 IST belongs to that day, not UTC’s', async () => {
  const perf = require('../services/performanceService');
  const ts = String(NOW.getTime() / 1000);
  await perf.syncMemberStandup(1, 7, { user: 'U1', ts, text: 'did things' });
  assert.equal(calls.recordPost[0][4], TEAM_TODAY);
});

test('Jira’s overdue query uses the team’s date and counts days from it', async () => {
  const jira = require('../services/jiraService');
  const [issue] = await jira.getOverdueIssues('QG');
  assert.match(calls.jiraGets[0].opts.params.jql, /duedate < "2026-09-16"/);
  assert.equal(issue.daysOverdue, 6);
});

test('checkout history counts back from the team’s today and honours working days', async () => {
  stubModule('repositories/memberRepository', { findById: async () => ({ id: 3, organisation_id: 1 }) });
  const router = require('../routes/checkout');
  const app = express();
  app.use('/api/checkout', router);

  const res = await request(app).get('/api/checkout/history?memberId=3&days=5');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.history.map((d) => d.date),
    ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
  assert.deepEqual(res.body.history.map((d) => d.isWeekend), [true, true, false, false, false]);

  cfg.workdays = '1-6';
  const six = await request(app).get('/api/checkout/history?memberId=3&days=5').expect(200);
  assert.deepEqual(six.body.history.map((d) => d.isWeekend), [false, true, false, false, false]);
});

test('sprint working days follow the team’s working days', () => {
  const planning = require('../services/sprintPlanningService');
  assert.equal(planning.countWorkingDays('2026-09-14', '2026-09-25'), 10);
  cfg.workdays = '1-6';
  assert.equal(planning.countWorkingDays('2026-09-14', '2026-09-25'), 11, 'Monday to Saturday, two weeks, minus the second Saturday outside the range');
});

// ─── Guard: nobody reintroduces the pattern ───────────────────────────────────

const BACKEND = path.join(__dirname, '..');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test', 'migrations'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no code asks the server or the database what day it is', () => {
  const forbidden = [
    [/CURRENT_DATE/, 'SQL CURRENT_DATE follows the database session zone — pass the team’s date as a parameter'],
    [/new Date\(\)\s*\.toISOString\(\)\s*\.(split|substring|slice)/, 'UTC date of "now" — use utils/teamClock.today()'],
    [/\.getDay\(\)/, 'server-zone weekday — use utils/dateOnly weekdayOf / workingDatesBetween'],
    [/5\.5\s*\*\s*60\s*\*\s*60/, 'hard-coded IST offset — use the team timezone via utils/timeZone'],
  ];
  const problems = [];
  for (const file of sourceFiles(BACKEND)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [re, why] of forbidden) {
      if (re.test(text)) problems.push(`${path.relative(BACKEND, file)}: ${why}`);
    }
  }
  assert.deepEqual(problems, []);
});
