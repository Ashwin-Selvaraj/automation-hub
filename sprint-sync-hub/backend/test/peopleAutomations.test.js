'use strict';

/**
 * The scheduled side of the people automations: who gets a prep pack and when,
 * that every message goes to the lead and only the lead, and that the routes
 * behind the People tab validate input and keep 1:1 content out of the shared
 * activity log.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { stubModule } = require('./helpers/mockRequire');

process.env.ORGANISATION_ID = '1';

const state = { scheduled: [], overview: [], sent: [], audit: [], recorded: [], prepFails: new Set(), today: '2026-09-16' };

stubModule('db', { query: async () => ({ rows: [] }) });
stubModule('repositories/peopleRepository', {
  scheduledMembers: async () => state.scheduled,
  overview:         async () => state.overview,
  setSchedule:      async (_org, id, s) => ({ id, one_on_one_weekday: s.weekday, one_on_one_cadence: s.cadence || 'weekly' }),
  recordOneOnOne:   async (_org, id, rec) => { state.recorded.push({ id, ...rec }); return { id: 1, member_id: id, ...rec }; },
  setActionDone:    async (_org, id, done) => (id === 404 ? null : { id, done_at: done ? 'now' : null }),
  recentOneOnOnes:  async () => [],
  actionsFor:       async () => [],
});
stubModule('core/notifier', {
  sendDM: async (opts) => { state.sent.push(opts); return { sent: true }; },
});
stubModule('core/auditLog', {
  record: (_org, entry) => { state.audit.push(entry); return Promise.resolve(); },
});
stubModule('utils/dateOnly', {
  ...require('../utils/dateOnly'),
  todayInZone: () => state.today,
});

const realPeopleService = require('../services/peopleService');
stubModule('services/peopleService', {
  ...realPeopleService,
  oneOnOnePrep: async (_org, id) => {
    if (state.prepFails.has(id)) throw new Error('Jira down');
    return { member: { id, name: `M${id}` } };
  },
  renderPrep: (prep) => `prep for ${prep.member.name}`,
  recognition: async (_org, { from, to }) => ({ from, to, people: [], github: 'not-configured' }),
  renderRecognition: () => 'recognition',
});

const prepAutomation = require('../automations/people/oneOnOnePrep');
const recognitionAutomation = require('../automations/people/weeklyRecognition');

function reset() {
  Object.assign(state, { scheduled: [], overview: [], sent: [], audit: [], recorded: [], prepFails: new Set(), today: '2026-09-16' });
  process.env.TEAM_LEAD_SLACK_ID = 'ULEAD';
}

// 2026-09-16 is a Wednesday.
const wed = (id, extra = {}) => ({ id, name: `M${id}`, slack_user_id: `U${id}`, one_on_one_weekday: 3, one_on_one_cadence: 'weekly', last_held_on: null, ...extra });

test('prep goes to the lead for each person whose 1:1 is today, and only them', async () => {
  reset();
  state.scheduled = [
    wed(1),
    wed(2, { one_on_one_weekday: 4 }),                                        // Thursday
    wed(3, { one_on_one_cadence: 'fortnightly', last_held_on: '2026-09-09' }), // held last week
  ];
  const out = await prepAutomation.run({ orgId: 1, cfg: { timezone: 'Asia/Kolkata' } });

  assert.deepEqual(out, { scheduled: 3, due: 1, sent: 1, held: 0, failed: 0 });
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].slackUserId, 'ULEAD', 'the lead receives it, never the person');
  assert.equal(state.sent[0].dedupeKey, 'one-on-one-prep:1:2026-09-16');
  assert.equal(state.sent[0].text, 'prep for M1');
});

test('one person’s failure does not stop the others', async () => {
  reset();
  state.scheduled = [wed(1), wed(2)];
  state.prepFails.add(1);
  const out = await prepAutomation.run({ orgId: 1, cfg: { timezone: 'UTC' } });
  assert.equal(out.failed, 1);
  assert.equal(out.sent, 1);
});

test('with no lead configured the people automations send nothing', async () => {
  reset();
  delete process.env.TEAM_LEAD_SLACK_ID;
  state.scheduled = [wed(1)];
  assert.ok((await prepAutomation.run({ orgId: 1, cfg: {} })).skipped);
  assert.ok((await recognitionAutomation.run({ orgId: 1, cfg: {} })).skipped);
  assert.equal(state.sent.length, 0);
});

test('recognition covers the last seven days and goes to the lead', async () => {
  reset();
  const out = await recognitionAutomation.run({ orgId: 1, cfg: { timezone: 'UTC' } });
  assert.equal(out.sent, true);
  assert.equal(state.sent[0].slackUserId, 'ULEAD');
  assert.equal(state.sent[0].dedupeKey, 'weekly-recognition:ULEAD:2026-09-16');
});

// ─── Routes ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/people', require('../routes/people'));

test('1:1 schedule rejects an impossible weekday or cadence', async () => {
  reset();
  await request(app).patch('/api/people/5/schedule').send({ weekday: 7 }).expect(400);
  await request(app).patch('/api/people/5/schedule').send({ weekday: '3' }).expect(400);
  await request(app).patch('/api/people/5/schedule').send({ weekday: 3, cadence: 'daily' }).expect(400);
  await request(app).patch('/api/people/abc/schedule').send({ weekday: 3 }).expect(400);
  const ok = await request(app).patch('/api/people/5/schedule').send({ weekday: 3, cadence: 'fortnightly' }).expect(200);
  assert.equal(ok.body.member.one_on_one_cadence, 'fortnightly');
  await request(app).patch('/api/people/5/schedule').send({ weekday: null }).expect(200);
});

test('recording a 1:1 validates follow-ups and keeps what was said out of the activity log', async () => {
  reset();
  state.overview = [{ id: 5, name: 'Alice' }];

  await request(app).post('/api/people/5/one-on-ones').send({ heldOn: 'yesterday' }).expect(400);
  await request(app).post('/api/people/5/one-on-ones')
    .send({ heldOn: '2026-09-16', actions: [{ owner: 'manager', text: 'x' }] }).expect(400);
  await request(app).post('/api/people/6/one-on-ones').send({ heldOn: '2026-09-16' }).expect(404);
  await request(app).post('/api/people/5/one-on-ones').send({ heldOn: '2999-01-01' }).expect(400);

  await request(app).post('/api/people/5/one-on-ones').send({
    heldOn: '2026-09-16',
    notes: 'Worried about a family matter',
    actions: [
      { owner: 'lead', text: 'Look into flexible hours' },
      { owner: 'member', text: '  ' }, // blank lines from the form are dropped
    ],
  }).expect(201);

  assert.equal(state.recorded.length, 1);
  assert.deepEqual(state.recorded[0].actions, [{ owner: 'lead', text: 'Look into flexible hours' }]);
  const logged = JSON.stringify(state.audit);
  assert.match(logged, /1:1 recorded for Alice with 1 follow-up/);
  assert.ok(!logged.includes('family'), 'notes never reach the shared activity log');
  assert.ok(!logged.includes('flexible'), 'nor do follow-ups');
});

test('follow-ups are ticked off with an explicit boolean', async () => {
  reset();
  await request(app).patch('/api/people/actions/3').send({ done: 'yes' }).expect(400);
  await request(app).patch('/api/people/actions/404').send({ done: true }).expect(404);
  const res = await request(app).patch('/api/people/actions/3').send({ done: true }).expect(200);
  assert.equal(res.body.action.id, 3);
});

test('a bad evidence window is a 400, not a 500', async () => {
  reset();
  await request(app).get('/api/people/5/evidence?from=2026-09-20&to=2026-09-01').expect(400);
});
