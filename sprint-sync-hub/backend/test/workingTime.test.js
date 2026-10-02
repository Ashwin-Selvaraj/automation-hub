'use strict';

/**
 * Expected values here were worked out by hand from the calendar, not by running
 * the code. Dates: Monday 2026-09-14, Friday 2026-09-18, Monday 2026-09-21.
 * Asia/Kolkata is UTC+5:30 all year, so 10:00 IST is 04:30Z.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { workingMinutesBetween, workingHoursBetween, parseWorkdays, toMinutes } = require('../utils/workingTime');

const IST = { timeZone: 'Asia/Kolkata', workStart: '09:00', workEnd: '18:00', workdays: '1-5' };

// Local IST wall-clock → ISO instant.
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`).toISOString();

test('a wait inside one working day is counted at face value', () => {
  assert.equal(workingHoursBetween(ist('2026-09-14', '10:00'), ist('2026-09-14', '15:00'), IST), 5);
});

test('overnight, only the two working slices count', () => {
  // Mon 17:00-18:00 (1h) + Tue 09:00-10:00 (1h)
  assert.equal(workingHoursBetween(ist('2026-09-14', '17:00'), ist('2026-09-15', '10:00'), IST), 2);
});

test('a PR opened Friday evening is not overdue by Saturday morning', () => {
  // The case that makes wall-clock SLAs unusable: 16h pass, 0 working hours do.
  assert.equal(workingHoursBetween(ist('2026-09-18', '18:00'), ist('2026-09-19', '10:00'), IST), 0);
});

test('the weekend is skipped between Friday and Monday', () => {
  // Fri 17:00-18:00 (1h) + Mon 09:00-10:00 (1h)
  assert.equal(workingHoursBetween(ist('2026-09-18', '17:00'), ist('2026-09-21', '10:00'), IST), 2);
});

test('time before opening is not counted', () => {
  // 07:00-09:00 is outside hours; only 09:00-10:00 counts.
  assert.equal(workingHoursBetween(ist('2026-09-14', '07:00'), ist('2026-09-14', '10:00'), IST), 1);
});

test('time after closing is not counted', () => {
  assert.equal(workingHoursBetween(ist('2026-09-14', '17:00'), ist('2026-09-14', '23:00'), IST), 1);
});

test('a whole day is the length of the working window, and a week is five of them', () => {
  assert.equal(workingHoursBetween(ist('2026-09-14', '00:00'), ist('2026-09-15', '00:00'), IST), 9);
  assert.equal(workingHoursBetween(ist('2026-09-14', '00:00'), ist('2026-09-21', '00:00'), IST), 45);
});

test('a range that sits wholly in the weekend is zero', () => {
  assert.equal(workingMinutesBetween(ist('2026-09-19', '00:00'), ist('2026-09-20', '23:59'), IST), 0);
});

test('the timezone decides where the working day sits', () => {
  // The same two instants: 04:30Z-09:30Z.
  const from = '2026-09-14T04:30:00Z';
  const to   = '2026-09-14T09:30:00Z';
  assert.equal(workingHoursBetween(from, to, IST), 5, 'in Kolkata that is 10:00-15:00, all working');
  assert.equal(workingHoursBetween(from, to, { ...IST, timeZone: 'UTC' }), 0.5, 'in UTC only 09:00-09:30 is');
});

test('working hours survive a daylight-saving change between the two ends', () => {
  // New York springs forward on Sunday 2026-03-08, so the UTC offset differs
  // between Friday (EST, -5) and Monday (EDT, -4). Window 09:00-17:00 local.
  const NY = { timeZone: 'America/New_York', workStart: '09:00', workEnd: '17:00', workdays: '1-5' };
  const from = '2026-03-06T20:00:00Z'; // Fri 15:00 EST
  const to   = '2026-03-09T15:00:00Z'; // Mon 11:00 EDT
  // Fri 15:00-17:00 (2h) + Mon 09:00-11:00 (2h)
  assert.equal(workingHoursBetween(from, to, NY), 4);
});

test('a six-day working week counts Saturday', () => {
  const sixDay = { ...IST, workdays: '1-6' };
  assert.equal(workingHoursBetween(ist('2026-09-19', '09:00'), ist('2026-09-19', '18:00'), sixDay), 9);
});

test('empty, reversed and unparseable ranges are zero rather than errors', () => {
  const t = ist('2026-09-14', '10:00');
  assert.equal(workingMinutesBetween(t, t, IST), 0);
  assert.equal(workingMinutesBetween(ist('2026-09-14', '15:00'), ist('2026-09-14', '10:00'), IST), 0);
  assert.equal(workingMinutesBetween('not a date', t, IST), 0);
  assert.equal(workingMinutesBetween(t, undefined, IST), 0);
});

test('a window that ends before it starts falls back to a normal day, not to zero', () => {
  const broken = { ...IST, workStart: '18:00', workEnd: '09:00' };
  assert.equal(workingHoursBetween(ist('2026-09-14', '10:00'), ist('2026-09-14', '15:00'), broken), 5);
});

test('inputs may be Dates, ISO strings or epoch milliseconds', () => {
  const a = new Date(ist('2026-09-14', '10:00'));
  const b = new Date(ist('2026-09-14', '12:00'));
  assert.equal(workingHoursBetween(a, b, IST), 2);
  assert.equal(workingHoursBetween(a.toISOString(), b.toISOString(), IST), 2);
  assert.equal(workingHoursBetween(a.getTime(), b.getTime(), IST), 2);
});

test('a very old wait is bounded rather than walking forever', () => {
  const started = Date.now();
  const hours = workingHoursBetween('2015-01-01T00:00:00Z', '2026-09-14T00:00:00Z', IST);
  assert.ok(hours > 1000, 'still reads as hugely over any SLA');
  assert.ok(Date.now() - started < 2000, 'and returns promptly');
});

test('day-of-week fields parse as cron does', () => {
  assert.deepEqual([...parseWorkdays('1-5')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseWorkdays('1,3,5')].sort(), [1, 3, 5]);
  assert.deepEqual([...parseWorkdays('0-6')].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(parseWorkdays('7').has(0), '7 is Sunday');
  assert.deepEqual([...parseWorkdays('')].sort(), [1, 2, 3, 4, 5], 'empty falls back to Monday-Friday');
  assert.deepEqual([...parseWorkdays('banana')].sort(), [1, 2, 3, 4, 5]);
});

test('HH:MM parsing rejects what is not a time', () => {
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(toMinutes('9:05'), 545);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('12:60'), null);
  assert.equal(toMinutes('noon'), null);
  assert.equal(toMinutes(undefined), null);
});
