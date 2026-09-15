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
    '12 of 20 done', '4 working days left',
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
