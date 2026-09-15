'use strict';

/**
 * A forecast a lead acts on has to be right, and — more importantly — has to
 * refuse to answer when it doesn't know. A confident projection built on two
 * data points is worse than no projection, because it gets believed.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';
stubModule('db', { query: async () => ({ rows: [] }) });

const risk = require('../services/deliveryRiskService');

// A two-week sprint, Monday to Friday-week-after.
const START = '2026-09-07'; // Monday
const END   = '2026-09-18'; // Friday of week 2

function days(spec) {
  return Object.entries(spec).map(([day, finished]) => ({ day, finished }));
}

test('working days are counted inclusively and skip weekends', () => {
  assert.equal(risk.workingDaysBetween('2026-09-07', '2026-09-07'), 1, 'one Monday');
  assert.equal(risk.workingDaysBetween('2026-09-07', '2026-09-11'), 5, 'Mon-Fri');
  assert.equal(risk.workingDaysBetween('2026-09-07', '2026-09-14'), 6, 'the weekend does not count');
  assert.equal(risk.workingDaysBetween('2026-09-12', '2026-09-13'), 0, 'Sat-Sun is zero');
});

test('refuses to forecast before there is enough signal', () => {
  const out = risk.forecast({
    open: 10, done: 1, unassigned: 0,
    completionsByDay: days({ '2026-09-07': 1 }),
    startDate: START, endDate: END,
    today: new Date('2026-09-08T12:00:00Z'), // day 2
  });

  assert.equal(out.status, 'too-early');
  assert.match(out.summary, /Too early to forecast/);
  assert.equal(out.projectedShortfall, undefined, 'no number may be offered this early');
});

test('an empty sprint says so rather than dividing by zero', () => {
  const out = risk.forecast({
    open: 0, done: 0, unassigned: 0, completionsByDay: [],
    startDate: START, endDate: END, today: new Date('2026-09-14T12:00:00Z'),
  });
  assert.equal(out.status, 'no-data');
});

test('nothing closed in a week is reported as stalled, not as on-track', () => {
  const out = risk.forecast({
    open: 8, done: 0, unassigned: 0, completionsByDay: [],
    startDate: START, endDate: END,
    today: new Date('2026-09-11T12:00:00Z'), // day 5
  });

  assert.equal(out.status, 'stalled');
  assert.equal(out.throughputPerDay, 0);
  assert.match(out.summary, /Nothing has been closed in 5 working days/);
});

test('comfortable throughput reads as on track', () => {
  // 8 closed over 5 working days = 1.6/day; 3 open, 5 days left.
  const out = risk.forecast({
    open: 3, done: 8, unassigned: 0,
    completionsByDay: days({
      '2026-09-07': 2, '2026-09-08': 2, '2026-09-09': 2, '2026-09-10': 1, '2026-09-11': 1,
    }),
    startDate: START, endDate: END,
    today: new Date('2026-09-11T12:00:00Z'),
  });

  assert.equal(out.status, 'on-track');
  assert.equal(out.projectedShortfall, 0);
  assert.equal(out.throughputPerDay, 1.6);
});

test('a shortfall is named as a count of tasks, not a percentage', () => {
  // 2 closed over 5 working days = 0.4/day; 12 open, 5 days left => capacity 2.
  const out = risk.forecast({
    open: 12, done: 2, unassigned: 0,
    completionsByDay: days({ '2026-09-08': 1, '2026-09-10': 1 }),
    startDate: START, endDate: END,
    today: new Date('2026-09-11T12:00:00Z'),
  });

  assert.equal(out.status, 'at-risk');
  assert.equal(out.projectedShortfall, 10, '12 open minus 0.4/day × 5 days');
  assert.match(out.summary, /10 tasks will not land/);
});

test('unassigned open work is called out in the at-risk summary', () => {
  const out = risk.forecast({
    open: 12, done: 2, unassigned: 3,
    completionsByDay: days({ '2026-09-08': 1, '2026-09-10': 1 }),
    startDate: START, endDate: END,
    today: new Date('2026-09-11T12:00:00Z'),
  });

  assert.match(out.summary, /3 of the open tasks have no assignee/);
});

test('the last day of a sprint leaves no remaining capacity', () => {
  const out = risk.forecast({
    open: 4, done: 6, unassigned: 0,
    completionsByDay: days({ '2026-09-07': 3, '2026-09-08': 3 }),
    startDate: START, endDate: END,
    today: new Date('2026-09-18T12:00:00Z'), // the final day
  });

  assert.equal(out.daysLeft, 0);
  assert.equal(out.status, 'at-risk');
  assert.equal(out.projectedShortfall, 4, 'with no days left, everything open is the shortfall');
});

test('the forecast does not change with the time of day it runs', () => {
  const base = {
    open: 12, done: 2, unassigned: 0,
    completionsByDay: days({ '2026-09-08': 1, '2026-09-10': 1 }),
    startDate: START, endDate: END,
  };

  const results = ['T00:00:00Z', 'T09:30:00Z', 'T12:00:00Z', 'T23:59:00Z'].map((time) =>
    risk.forecast({ ...base, today: new Date(`2026-09-11${time}`) })
  );

  // A date carrying a time component used to fail the final day's comparison,
  // so an afternoon run quietly lost a working day of capacity.
  const distinct = new Set(results.map((r) => `${r.daysLeft}:${r.projectedShortfall}`));
  assert.equal(distinct.size, 1, `forecast drifted across the day: ${[...distinct].join(' vs ')}`);
});

test('counting days does not mutate the caller\'s date', () => {
  const today = new Date('2026-09-11T12:00:00Z');
  const before = today.getTime();
  risk.workingDaysBetween(today, END);
  assert.equal(today.getTime(), before, 'the input date must come back unchanged');
});

test('WIP breaches list only people over the limit, worst first', () => {
  const rows = [
    { name: 'Alice', in_flight: 5, keys: ['QG-1', 'QG-2', 'QG-3', 'QG-4', 'QG-5'] },
    { name: 'Bob',   in_flight: 4, keys: ['QG-6', 'QG-7', 'QG-8', 'QG-9'] },
    { name: 'Carol', in_flight: 3, keys: ['QG-10'] },
    { name: 'Dave',  in_flight: 1, keys: ['QG-11'] },
  ];
  const out = risk.wipBreaches(rows, 3);

  assert.deepEqual(out.map((p) => p.name), ['Alice', 'Bob'], 'at the limit is not over it');
  assert.equal(out[0].over, 2);
  assert.equal(out[1].over, 1);
});

test('the WIP limit is configurable', () => {
  const rows = [{ name: 'Alice', in_flight: 5, keys: [] }];
  assert.equal(risk.wipBreaches(rows, 3).length, 1);
  assert.equal(risk.wipBreaches(rows, 5).length, 0);
  assert.equal(risk.wipBreaches(rows, 10).length, 0);
});

test('a long key list is trimmed so one person cannot fill the brief', () => {
  const rows = [{
    name: 'Alice', in_flight: 12,
    keys: Array.from({ length: 12 }, (_, i) => `QG-${i}`),
  }];
  assert.equal(risk.wipBreaches(rows, 3)[0].keys.length, 6);
});
