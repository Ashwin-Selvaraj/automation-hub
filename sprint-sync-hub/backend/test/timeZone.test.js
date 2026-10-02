'use strict';

/**
 * The single home for wall-clock arithmetic. Four copies of this used to exist;
 * these tests pin the behaviour all their callers now share.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../utils/timeZone');

test('local parts are read in the given zone, with midnight as hour 0', () => {
  // 18:30 UTC on Tuesday the 15th is 00:00 on Wednesday the 16th in Kolkata.
  const p = tz.localParts('2026-09-15T18:30:00Z', 'Asia/Kolkata');
  assert.deepEqual(
    { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, wd: p.weekday },
    { y: 2026, m: 9, d: 16, h: 0, min: 0, wd: 3 },
  );
});

test('the date of an instant depends on the zone', () => {
  assert.equal(tz.dateInZone('2026-09-15T20:00:00Z', 'Asia/Kolkata'), '2026-09-16');
  assert.equal(tz.dateInZone('2026-09-15T20:00:00Z', 'UTC'), '2026-09-15');
  assert.equal(tz.dateInZone('2026-09-15T20:00:00Z', undefined), '2026-09-15', 'no zone means UTC');
  assert.equal(tz.todayInZone('America/Los_Angeles', new Date('2026-09-16T03:00:00Z')), '2026-09-15');
});

test('local clock gives minutes past midnight and the weekday', () => {
  assert.deepEqual(tz.localClock('2026-09-19T04:15:00Z', 'Asia/Kolkata'), { minutes: 9 * 60 + 45, weekday: 6 });
});

test('a day window runs midnight to midnight in the team’s zone', () => {
  const w = tz.dayWindow(new Date('2026-09-23T12:00:00Z'), 'Asia/Kolkata');
  assert.equal(w.date, '2026-09-23');
  assert.equal(w.start.toISOString(), '2026-09-22T18:30:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-23T18:30:00.000Z');
});

test('a day window across a daylight-saving change is 23 or 25 hours, not 24', () => {
  const spring = tz.dayWindow(new Date('2026-03-08T17:00:00Z'), 'America/New_York');
  assert.equal(spring.date, '2026-03-08');
  assert.equal(spring.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal((spring.end - spring.start) / 3_600_000, 23);

  const autumn = tz.dayWindow(new Date('2026-11-01T17:00:00Z'), 'America/New_York');
  assert.equal((autumn.end - autumn.start) / 3_600_000, 25);
});

test('converting a local wall-clock time back to UTC round-trips', () => {
  const ms = tz.zonedToUtcMs(2026, 9, 16, 9 * 60 + 30, 'Asia/Kolkata');
  assert.equal(new Date(ms).toISOString(), '2026-09-16T04:00:00.000Z');
});

test('an unknown zone is an error, not a silent UTC', () => {
  assert.throws(() => tz.dateInZone(Date.now(), 'Mars/Olympus'), RangeError);
});
