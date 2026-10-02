'use strict';

/**
 * Regression test for the one-day-early DATE bug.
 *
 * node-postgres hands back a DATE column as a Date at LOCAL midnight. On a server
 * east of UTC, reading it with UTC components yields the previous day — so
 * scope-creep dates and the sprint start and end feeding the forecast were all a
 * day out, while passing on a UTC host. This file pins the server to Asia/Kolkata
 * (each test file runs in its own process, so that is contained) and feeds
 * assess() dates in exactly the shape the driver returns.
 */

process.env.TZ = 'Asia/Kolkata';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

// Precondition: the zone must actually be in effect, or this proves nothing.
const zoneInEffect = new Date(2026, 8, 13).toISOString().startsWith('2026-09-12');

let addedAfterStartArg;

stubModule('repositories/sprintRepository', {
  getActiveSprint: async () => ({
    id: 1, name: 'Sprint 7',
    start_date: new Date(2026, 8, 7),    // DATE '2026-09-07' as pg returns it
    end_date:   new Date(2026, 8, 18),   // DATE '2026-09-18'
  }),
});
stubModule('repositories/deliveryRepository', {
  openAndDone: async () => ({ open: 4, done: 2, unassigned: 0 }),
  completionsByDay: async () => [],
  openWorkPerMember: async () => [],
  addedAfterStart: async (org, sprintId, startDate) => {
    addedAfterStartArg = startDate;
    return [{
      jira_key: 'QG-20', title: 'Hotfix', status: 'To Do', assignee: 'Bob',
      created_at_jira: new Date(2026, 8, 13),   // DATE '2026-09-13'
      completed_at: null,
    }];
  },
});
stubModule('services/configService', { getSprintConfig: () => ({ timezone: 'Asia/Kolkata' }) });
stubModule('db', { query: async () => ({ rows: [] }) });

const risk = require('../services/deliveryRiskService');

test('the test is really running in a zone east of UTC', { skip: zoneInEffect ? false : 'this platform ignores a runtime TZ change' }, () => {
  assert.equal(new Date(2026, 8, 13).toISOString().substring(0, 10), '2026-09-12', 'the naive reading is the buggy one here');
});

test('scope-creep dates are the calendar day Postgres stored, not the day before', { skip: !zoneInEffect }, async () => {
  const out = await risk.assess(1);
  assert.equal(out.scopeAdded[0].addedOn, '2026-09-13');
});

test('the sprint start and end are the stored calendar days', { skip: !zoneInEffect }, async () => {
  const out = await risk.assess(1);
  assert.equal(out.sprint.startDate, '2026-09-07');
  assert.equal(out.sprint.endDate, '2026-09-18');
});

test('the query is handed a plain date string, not a Date that could shift in transit', { skip: !zoneInEffect }, async () => {
  await risk.assess(1);
  assert.equal(addedAfterStartArg, '2026-09-07');
});
