'use strict';

/**
 * The bug these guard against only exists when the server is NOT on UTC, so the
 * important tests run a child process under several timezones. A test that only
 * ran in the host's own zone would pass in UTC CI and prove nothing.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { dateOnlyString, dateOnlyToUtc, todayInZone } = require('../utils/dateOnly');
const MODULE = path.join(__dirname, '..', 'utils', 'dateOnly.js');

/** Runs a snippet with `d` bound to the module, under a given server timezone. */
function underZone(tz, snippet) {
  const out = spawnSync(process.execPath, ['-e', `const d = require(${JSON.stringify(MODULE)}); process.stdout.write(String(${snippet}));`], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];

test('a pg DATE (local midnight) reads back as the same calendar day in every server timezone', () => {
  for (const tz of ZONES) {
    // This is exactly what node-postgres builds for DATE '2026-09-13'.
    const out = underZone(tz, "d.dateOnlyString(new Date(2026, 8, 13))");
    assert.equal(out, '2026-09-13', `server timezone ${tz}`);
  }
});

test('the obvious UTC-components approach is wrong east of UTC — which is why this helper exists', () => {
  const east = underZone('Asia/Kolkata', "new Date(2026, 8, 13).toISOString().substring(0, 10)");
  assert.equal(east, '2026-09-12', 'one day early in Kolkata');
  const utc = underZone('UTC', "new Date(2026, 8, 13).toISOString().substring(0, 10)");
  assert.equal(utc, '2026-09-13', 'right only on a UTC server');
});

test('month and year boundaries survive too', () => {
  for (const tz of ZONES) {
    assert.equal(underZone(tz, "d.dateOnlyString(new Date(2026, 0, 1))"), '2026-01-01', `New Year in ${tz}`);
    assert.equal(underZone(tz, "d.dateOnlyString(new Date(2026, 11, 31))"), '2026-12-31', `New Year's Eve in ${tz}`);
    assert.equal(underZone(tz, "d.dateOnlyString(new Date(2028, 1, 29))"), '2028-02-29', `leap day in ${tz}`);
  }
});

test('strings pass through, trimmed to the date', () => {
  assert.equal(dateOnlyString('2026-09-13'), '2026-09-13');
  assert.equal(dateOnlyString('2026-09-13T18:30:00.000Z'), '2026-09-13');
});

test('nothing parseable gives null rather than "Invalid Date" or NaN', () => {
  for (const v of [null, undefined, '', 'tomorrow', new Date('nope'), '13/09/2026']) {
    assert.equal(dateOnlyString(v), null, String(v));
  }
});

test('dateOnlyToUtc gives UTC midnight, so day arithmetic is exact in any zone', () => {
  for (const tz of ZONES) {
    const out = underZone(tz, "d.dateOnlyToUtc(new Date(2026, 8, 13)).toISOString()");
    assert.equal(out, '2026-09-13T00:00:00.000Z', tz);
  }
  assert.equal(dateOnlyToUtc('2026-09-13').toISOString(), '2026-09-13T00:00:00.000Z');
  assert.equal(dateOnlyToUtc(null), null);
});

test("today is asked in the team's zone, not UTC's", () => {
  // 20:30 UTC on the 13th is already 02:00 on the 14th in Kolkata.
  const instant = new Date('2026-09-13T20:30:00Z');
  assert.equal(todayInZone('Asia/Kolkata', instant), '2026-09-14');
  assert.equal(todayInZone('UTC', instant), '2026-09-13');
  assert.equal(todayInZone('America/Los_Angeles', instant), '2026-09-13');
  assert.equal(todayInZone('Pacific/Auckland', instant), '2026-09-14');
});

test('a missing zone falls back to UTC rather than throwing', () => {
  assert.equal(todayInZone(undefined, new Date('2026-09-13T20:30:00Z')), '2026-09-13');
});
